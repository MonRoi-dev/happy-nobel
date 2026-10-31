import { chromium, type BrowserContext, type Page } from 'playwright';
import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';
import { agentLogger } from '../logger/index.ts';
import { HhVacancyApplyFsm, type IVacancyApplyFsm } from './hh-apply-fsm.ts';
import { closeActiveCaptchaSession, retainActiveCaptchaSession } from './hh-captcha.detector.ts';
import {
  buildHhSearchVacanciesUrl,
  HhVacancyFullResponseSchema,
  HhVacancySearchResponseSchema,
  isBrowserClosedError,
  normalizeScrapedNegotiationStatus,
  stripHtmlTags,
  type ApplyToVacancyInput,
  type HhVacancyFullResponse,
  type HhVacancySearchResponse,
  type HhVacancyShortItem,
  type ScrapedNegotiationItem,
  type ValidatedVacancySearchQuery,
} from './hh-hybrid.schemas.ts';

const logger = createLogger('HhPlaywrightDriver');

export interface WarmBrowserSessionOptions {
  readonly keepWarmMs?: number;
  readonly blockHeavyResources?: boolean;
}

export const TRACKER_DOMAINS = [
  'mc.yandex.ru',
  'google-analytics.com',
  'googletagmanager.com',
  'top-fwz1.mail.ru',
  'vk.com/rtrg',
] as const;

export function isTrackerUrl(url: string): boolean {
  return TRACKER_DOMAINS.some((domain) => url.includes(domain));
}

export interface ScrapedVacancyDetailsResult {
  readonly vacancy: HhVacancyFullResponse;
  readonly cleanDescription: string;
  readonly salaryText: string;
}

export interface PlaywrightBrowserDriver {
  loginAndScrapeResume(sessionDir: string): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>>;
  verifySessionAndScrapeResume?(sessionDir: string): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>>;
  notifyLoginConfirmed?(): void;
  searchVacanciesInBrowser(
    sessionDir: string,
    query: ValidatedVacancySearchQuery
  ): Promise<SafeResult<HhVacancySearchResponse>>;
  scrapeVacancyDetailsInBrowser(
    sessionDir: string,
    vacancyId: string
  ): Promise<SafeResult<ScrapedVacancyDetailsResult>>;
  applyInBrowser(sessionDir: string, input: ApplyToVacancyInput): Promise<SafeResult<boolean>>;
  scrapeNegotiationsInBrowser(sessionDir: string): Promise<SafeResult<ScrapedNegotiationItem[]>>;
  bumpResumeInBrowser(sessionDir: string): Promise<SafeResult<'bumped' | 'not_ready'>>;
  closeWarmSession?(): Promise<void>;
}

async function scrapeResumeFromResumesPage(
  page: Page,
  webBaseUrl: string
): Promise<{ hhResumeTitle: string; resumeRawText: string }> {
  const firstResumeLink = page.locator('a[data-qa^="resume-card-link"], a[href*="/resume/"]').first();
  const linkCount = await firstResumeLink.count().catch(() => 0);
  let hhResumeTitle = 'Основное резюме HH.ru';
  let resumeHref: string | null = null;
  if (linkCount > 0) {
    const rawTitle = (await firstResumeLink.innerText().catch(() => ''))?.trim();
    const firstLine = rawTitle ? rawTitle.split('\n')[0]?.trim() : '';
    if (firstLine) hhResumeTitle = firstLine;
    const href = await firstResumeLink.getAttribute('href').catch(() => null);
    if (href) resumeHref = href.startsWith('http') ? href : `${webBaseUrl}${href}`;
  }
  if (resumeHref) {
    await page.goto(resumeHref, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const bodyText = await page.locator('main, [data-qa="resume-block"], body').first().innerText().catch(() => '');
  const resumeRawText = bodyText.replace(/[ \t]+/g, ' ').trim();
  return {
    hhResumeTitle,
    resumeRawText: resumeRawText.length >= 20 ? resumeRawText : hhResumeTitle,
  };
}

export class DefaultPlaywrightBrowserDriver implements PlaywrightBrowserDriver {
  private readonly webBaseUrl: string;
  private readonly applyFsm: IVacancyApplyFsm;
  private readonly questionSolver?: (
    context: { vacancyId: string; vacancyUrl: string; vacancyTitle?: string; companyName?: string },
    questions: ReadonlyArray<EmployerQuestionItem>
  ) => Promise<SafeResult<EmployerQuestionAnswer[]>>;
  private readonly keepWarmMs: number;
  private readonly blockHeavyResources: boolean;
  private warmContext: BrowserContext | null = null;
  private warmSessionDir: string | null = null;
  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null;

  private loginConfirmedResolver: (() => void) | null = null;

  constructor(
    webBaseUrlOrOptions?: string | WarmBrowserSessionOptions,
    applyFsm: IVacancyApplyFsm = new HhVacancyApplyFsm(),
    questionSolver?: (
      context: { vacancyId: string; vacancyUrl: string; vacancyTitle?: string; companyName?: string },
      questions: ReadonlyArray<EmployerQuestionItem>
    ) => Promise<SafeResult<EmployerQuestionAnswer[]>>,
    warmOptions?: WarmBrowserSessionOptions
  ) {
    const isOptionsObject = typeof webBaseUrlOrOptions === 'object' && webBaseUrlOrOptions !== null;
    const effectiveOptions = isOptionsObject ? webBaseUrlOrOptions : (warmOptions ?? {});
    const webBaseUrl = typeof webBaseUrlOrOptions === 'string' ? webBaseUrlOrOptions : 'https://hh.ru';

    this.webBaseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
    this.applyFsm = applyFsm;
    this.questionSolver = questionSolver;
    this.keepWarmMs = effectiveOptions.keepWarmMs ?? 90_000;
    this.blockHeavyResources = effectiveOptions.blockHeavyResources ?? true;
  }

  public async closeWarmSession(): Promise<void> {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
    const ctx = this.warmContext;
    this.warmContext = null;
    this.warmSessionDir = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  private async acquireWarmContext(sessionDir: string): Promise<BrowserContext> {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
    if (this.warmContext && this.warmSessionDir !== sessionDir) {
      await this.closeWarmSession();
    }
    if (this.keepWarmMs > 0 && this.warmContext) {
      try {
        if (this.warmContext.pages().length >= 0) return this.warmContext;
      } catch {
        this.warmContext = null;
        this.warmSessionDir = null;
      }
    }
    const context = await chromium.launchPersistentContext(sessionDir, {
      headless: true,
      viewport: { width: 1280, height: 840 },
    });
    if (this.blockHeavyResources) await this.attachTrackerBlocker(context);
    if (this.keepWarmMs > 0) {
      this.warmContext = context;
      this.warmSessionDir = sessionDir;
    }
    return context;
  }

  private async attachTrackerBlocker(context: BrowserContext): Promise<void> {
    if (typeof context.route !== 'function') return;
    await context.route('**/*', async (route) => {
      if (isTrackerUrl(route.request().url())) {
        await route.abort().catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
  }

  private async releaseWarmContext(context: BrowserContext, options?: { retained?: boolean }): Promise<void> {
    if (options?.retained) {
      if (this.warmContext === context) {
        this.warmContext = null;
        this.warmSessionDir = null;
        if (this.warmIdleTimer) {
          clearTimeout(this.warmIdleTimer);
          this.warmIdleTimer = null;
        }
      }
      return;
    }
    if (this.keepWarmMs > 0 && this.warmContext === context) {
      try {
        const pages = context.pages();
        for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => undefined);
      } catch {
        this.warmContext = null;
        this.warmSessionDir = null;
        return;
      }
      if (this.warmIdleTimer) clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = setTimeout(() => { void this.closeWarmSession(); }, this.keepWarmMs).unref();
      return;
    }
    await context.close().catch(() => undefined);
    if (this.warmContext === context) {
      this.warmContext = null;
      this.warmSessionDir = null;
    }
  }

  public notifyLoginConfirmed(): void {
    if (this.loginConfirmedResolver) {
      this.loginConfirmedResolver();
      this.loginConfirmedResolver = null;
    }
  }

  public async loginAndScrapeResume(
    sessionDir: string
  ): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      await this.closeWarmSession();
      logger.info('Запуск интерактивного браузера Chromium (headless: false) для входа в HH.ru...');
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: false,
        viewport: { width: 1280, height: 840 },
      });

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      await page.goto(`${this.webBaseUrl}/account/login`, { waitUntil: 'domcontentloaded' });
      logger.info('Ожидание завершения входа пользователем в окне браузера (таймаут 5 мин)...');

      let isManualConfirmation = false;
      const manualConfirmPromise = new Promise<void>((resolve) => {
        this.loginConfirmedResolver = () => {
          isManualConfirmation = true;
          resolve();
        };
      });

      await Promise.race([
        page.waitForURL(
          (url) => !url.pathname.includes('/account/login') && !url.pathname.includes('/account/signup'),
          { timeout: 300_000 }
        ).catch((err) => {
          if (!isManualConfirmation) throw err;
        }),
        manualConfirmPromise,
      ]);
      this.loginConfirmedResolver = null;

      logger.info('Вход зафиксирован. Переход к списку резюме (/applicant/resumes)...');
      await page.goto(`${this.webBaseUrl}/applicant/resumes`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const scraped = await scrapeResumeFromResumesPage(page, this.webBaseUrl);
      logger.info(`Профиль резюме успешно считан: "${scraped.hhResumeTitle}" (${scraped.resumeRawText.length} симв.).`);

      return {
        data: scraped,
        error: null,
      };
    } catch (err) {
      if (context) {
        await context.close().catch(() => undefined);
        context = null;
      }

      const fallbackCheck = await this.verifySessionAndScrapeResume(sessionDir);
      if (fallbackCheck.data) {
        logger.info(`Авторизация подтверждена после закрытия браузера: "${fallbackCheck.data.hhResumeTitle}".`);
        return fallbackCheck;
      }

      if (isBrowserClosedError(err)) {
        logger.info('Интерактивный вход через Playwright отменен (браузер или контекст закрыт).');
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error('Ошибка интерактивного входа через Playwright', err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'LOGIN_BROWSER_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright interactive login or resume scraping failed',
      });
      const message = err instanceof Error ? err.message : 'Interactive Playwright login failed';
      return { data: null, error: message };
    } finally {
      this.loginConfirmedResolver = null;
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await context.close();
      }
    }
  }

  public async verifySessionAndScrapeResume(
    sessionDir: string
  ): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      logger.info('Проверка сессии HH.ru в headless-браузере...');
      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      await page.goto(`${this.webBaseUrl}/applicant/resumes`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const url = page.url();
      if (url.includes('/account/login') || url.includes('/account/signup')) {
        logger.info('Сессия HH.ru не авторизована: редирект на /account/login.');
        return { data: null, error: 'HH_SESSION_NOT_LOGGED_IN' };
      }

      const scraped = await scrapeResumeFromResumesPage(page, this.webBaseUrl);
      logger.info(`Сессия HH.ru подтверждена: "${scraped.hhResumeTitle}" (${scraped.resumeRawText.length} симв.).`);
      return {
        data: scraped,
        error: null,
      };
    } catch (err) {
      logger.warn(`Ошибка проверки сессии HH.ru: ${err instanceof Error ? err.message : String(err)}`);
      return { data: null, error: err instanceof Error ? err.message : 'Session verification failed' };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }

  public async searchVacanciesInBrowser(
    sessionDir: string,
    query: ValidatedVacancySearchQuery
  ): Promise<SafeResult<HhVacancySearchResponse>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      const searchUrl = buildHhSearchVacanciesUrl(this.webBaseUrl, query);
      logger.info(`Парсинг списка вакансий через Playwright: ${searchUrl}`);

      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const navResp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      if (navResp && navResp.status() >= 400) {
        await agentLogger.logPlaywrightError({
          traceId: agentLogger.createTraceId(),
          module: 'HH_BROWSER',
          action: 'VACANCY_NAVIGATION',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru returned HTTP >= 400 inside Playwright persistent session; check cookies or anti-bot challenge',
        });
        return { data: null, error: `HTTP ${navResp.status()}: access denied or search error` };
      }

      await page
        .locator('a[data-qa="serp-item__title"]')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);

      const rawItems = await page.evaluate(async (baseUrl) => {
        for (let step = 0; step < 5; step++) {
          window.scrollBy(0, window.innerHeight * 2);
          await new Promise((r) => setTimeout(r, 180));
        }
        const normalizeText = (value: string | null | undefined): string =>
          (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

        const links = Array.from(document.querySelectorAll('a[data-qa="serp-item__title"]'));
        const seenIds = new Set<string>();
        const extracted: Array<{
          id: string;
          name: string;
          alternate_url: string;
          archived: boolean;
          has_test: boolean;
          response_letter_required: boolean;
          employer: { name: string };
          snippet: { requirement: string | null; responsibility: string | null };
        }> = [];

        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/vacancy\/(\d+)/);
          const id = match ? match[1] : null;
          if (!id || seenIds.has(id)) {
            continue;
          }
          seenIds.add(id);

          const card = link.closest('[data-qa="vacancy-serp__vacancy"]') || link.closest('.serp-item') || link.parentElement;
          const employerEl = card?.querySelector('[data-qa="vacancy-serp__vacancy-employer"], a[data-qa="vacancy-serp__vacancy-employer-title"]');
          const respEl = card?.querySelector('[data-qa="vacancy-serp__vacancy_snippet_responsibility"]');
          const reqEl = card?.querySelector('[data-qa="vacancy-serp__vacancy_snippet_requirement"]');

          const name = normalizeText(link.textContent) || 'Без названия';
          const employerName = normalizeText(employerEl?.textContent) || 'Работодатель не указан';
          const requirement = normalizeText(reqEl?.textContent) || null;
          const responsibility = normalizeText(respEl?.textContent) || null;

          const alternate_url = href.startsWith('http') ? href : `${baseUrl}${href}`;

          extracted.push({
            id,
            name,
            alternate_url,
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: employerName },
            snippet: { requirement, responsibility },
          });
        }
        return extracted;
      }, this.webBaseUrl);

      const items: HhVacancyShortItem[] = rawItems.slice(0, query.perPage);
      const responsePayload: HhVacancySearchResponse = {
        items,
        found: items.length,
        page: query.page,
        pages: items.length > 0 ? query.page + 1 : 0,
        per_page: query.perPage,
      };

      const parsed = HhVacancySearchResponseSchema.safeParse(responsePayload);
      if (!parsed.success) {
        return {
          data: null,
          error: `Invalid scraped vacancy list schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        };
      }

      return { data: parsed.data, error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        logger.info('Парсинг поиска вакансий через Playwright отменен (браузер или контекст закрыт).');
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error('Ошибка парсинга поиска вакансий через Playwright', err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'PLAYWRIGHT_SCRAPE_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright selector wait or page evaluation failed',
      });
      const message = err instanceof Error ? err.message : 'Playwright vacancy search failed';
      return { data: null, error: message };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }

  public async scrapeVacancyDetailsInBrowser(
    sessionDir: string,
    vacancyId: string
  ): Promise<SafeResult<ScrapedVacancyDetailsResult>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      const vacancyUrl = `${this.webBaseUrl}/vacancy/${encodeURIComponent(vacancyId)}`;
      logger.info(`Парсинг описания вакансии ${vacancyId} через Playwright: ${vacancyUrl}`);

      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const navResp = await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded' });
      if (navResp && navResp.status() >= 400) {
        await agentLogger.logPlaywrightError({
          traceId: agentLogger.createTraceId(),
          module: 'HH_BROWSER',
          action: 'VACANCY_NAVIGATION',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru returned HTTP >= 400 inside Playwright persistent session; check cookies or anti-bot challenge',
        });
        return { data: null, error: `HTTP ${navResp.status()}: access denied or vacancy error` };
      }

      await page
        .locator('[data-qa="vacancy-title"], [data-qa="vacancy-description"]')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);

      const scraped = await page.evaluate(() => {
        const normalizeText = (value: string | null | undefined): string =>
          (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

        const titleEl = document.querySelector('[data-qa="vacancy-title"]');
        const companyEl = document.querySelector(
          '[data-qa="vacancy-company-name"], [data-qa="bloko-header-2"]'
        );
        const salaryEl = document.querySelector(
          '[data-qa="vacancy-salary"], [data-qa="vacancy-salary-compensation-type-net"], [data-qa="vacancy-salary-compensation-type-gross"]'
        );
        const descEl = document.querySelector('[data-qa="vacancy-description"]');
        const archiveEl = document.querySelector('[data-qa="vacancy-archive-description"]');

        const skillNodes = Array.from(
          document.querySelectorAll('[data-qa="skills-element"], [data-qa="bloko-tag__text"]')
        );
        const keySkills = skillNodes
          .map((node) => ({ name: normalizeText(node.textContent) }))
          .filter((item) => item.name.length > 0);

        return {
          name: normalizeText(titleEl?.textContent),
          companyName: normalizeText(companyEl?.textContent) || 'Unknown Company',
          salaryText: normalizeText(salaryEl?.textContent) || 'Не указана',
          descriptionHtml: descEl?.innerHTML ?? '',
          descriptionText: normalizeText(descEl?.textContent),
          archived: Boolean(archiveEl),
          keySkills,
        };
      });

      if (!scraped.name) {
        return {
          data: null,
          error: `Не удалось считать заголовок вакансии ${vacancyId} со страницы ${vacancyUrl}`,
        };
      }

      const cleanDescription =
        stripHtmlTags(scraped.descriptionHtml) || scraped.descriptionText;

      const rawVacancy = {
        id: vacancyId,
        name: scraped.name,
        description: scraped.descriptionHtml || cleanDescription,
        alternate_url: vacancyUrl,
        archived: scraped.archived,
        has_test: false,
        response_letter_required: false,
        salary: null,
        employer: {
          name: scraped.companyName,
        },
        key_skills: scraped.keySkills,
      };

      const parsedVacancy = HhVacancyFullResponseSchema.safeParse(rawVacancy);
      if (!parsedVacancy.success) {
        return {
          data: null,
          error: `Invalid scraped vacancy details: ${parsedVacancy.error.issues[0]?.message ?? 'unknown'}`,
        };
      }

      return {
        data: {
          vacancy: parsedVacancy.data,
          cleanDescription,
          salaryText: scraped.salaryText,
        },
        error: null,
      };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        logger.info(`Парсинг деталей вакансии ${vacancyId} отменен (браузер или контекст закрыт).`);
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error(`Ошибка парсинга деталей вакансии ${vacancyId} через Playwright`, err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'PLAYWRIGHT_SCRAPE_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright selector wait or page evaluation failed',
      });
      const message = err instanceof Error ? err.message : 'Playwright vacancy details scrape failed';
      return { data: null, error: message };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }

  public async applyInBrowser(
    sessionDir: string,
    input: ApplyToVacancyInput
  ): Promise<SafeResult<boolean>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      await closeActiveCaptchaSession();
      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const fsmResult = await this.applyFsm.execute({
        page,
        vacancyId: input.vacancyId,
        vacancyUrl: input.vacancyUrl,
        vacancyTitle: input.vacancyTitle,
        companyName: input.companyName,
        resumeTitle: input.resumeTitle,
        coverLetter: input.coverLetter,
        webBaseUrl: this.webBaseUrl,
        skipForeignVacancies: input.skipForeignVacancies ?? true,
        questionSolver: this.questionSolver
          ? (questions, ctx) =>
              this.questionSolver!(
                {
                  vacancyId: ctx?.vacancyId ?? input.vacancyId,
                  vacancyUrl: ctx?.vacancyUrl ?? input.vacancyUrl,
                  vacancyTitle: ctx?.vacancyTitle ?? input.vacancyTitle,
                  companyName: ctx?.companyName ?? input.companyName,
                },
                questions
              )
          : undefined,
      });

      if (fsmResult.error || !fsmResult.data) {
        if (fsmResult.error === 'CAPTCHA_REQUIRED' && context) {
          retainActiveCaptchaSession(context, page, async () => {
            await this.applyFsm.completeAfterCaptcha?.({
              page,
              vacancyId: input.vacancyId,
              vacancyUrl: input.vacancyUrl,
              vacancyTitle: input.vacancyTitle,
              companyName: input.companyName,
              resumeTitle: input.resumeTitle,
              coverLetter: input.coverLetter,
              webBaseUrl: this.webBaseUrl,
              skipForeignVacancies: input.skipForeignVacancies ?? true,
            });
          });
          await this.releaseWarmContext(context, { retained: true });
          context = null;
        }
        return { data: null, error: fsmResult.error ?? 'Application execution failed' };
      }

      if (fsmResult.data.alreadyApplied) {
        return { data: false, error: 'ALREADY_APPLIED' };
      }

      if (input.coverLetter && !fsmResult.data.coverLetterAttached) {
        logger.warn(
          `[HhHybrid] Отклик на вакансию ${input.vacancyId} отправлен, но сопроводительное письмо не удалось доставить!`
        );
      } else if (input.coverLetter && fsmResult.data.coverLetterAttached) {
        logger.info(
          `[HhHybrid] Отклик на вакансию ${input.vacancyId} успешно отправлен вместе с сопроводительным письмом.`
        );
      }

      return { data: fsmResult.data.applied, error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        logger.info(`Headless-отклик на вакансию ${input.vacancyId} отменен (браузер или контекст закрыт).`);
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error(`Ошибка headless-отклика на вакансию ${input.vacancyId}`, err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'APPLY_BROWSER_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright apply failed',
      });
      const message = err instanceof Error ? err.message : 'Headless Playwright apply failed';
      return { data: null, error: message };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }

  public async scrapeNegotiationsInBrowser(
    sessionDir: string
  ): Promise<SafeResult<ScrapedNegotiationItem[]>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const navResp = await page.goto(`${this.webBaseUrl}/applicant/negotiations`, { waitUntil: 'domcontentloaded' });
      if (navResp && navResp.status() >= 400) {
        await agentLogger.logPlaywrightError({
          traceId: agentLogger.createTraceId(),
          module: 'HH_BROWSER',
          action: 'NEGOTIATIONS_NAVIGATION',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru negotiations returned HTTP >= 400; check cookies or anti-bot challenge',
        });
        return { data: null, error: `HTTP ${navResp.status()}: negotiations navigation failed` };
      }
      await page.waitForTimeout(2000);

      if (page.url().includes('/account/login')) {
        return {
          data: null,
          error: 'Сессия HH.ru не авторизована в браузере (редирект на /account/login). Нажмите "🔑 Войти в HH.ru" в боте.',
        };
      }

      const itemsLocator = page.locator('[data-qa="negotiations-item"]');
      const count = await itemsLocator.count();
      const results: ScrapedNegotiationItem[] = [];

      for (let i = 0; i < Math.min(count, 50); i++) {
        const row = itemsLocator.nth(i);
        const link = row.locator('a[href*="/vacancy/"]').first();
        const href = (await link.count()) > 0 ? await link.getAttribute('href') : null;
        const vacancyMatch = href ? /\/vacancy\/(\d+)/.exec(href) : null;
        const vacancyId = vacancyMatch?.[1];

        if (!vacancyId) {
          continue;
        }

        const tagElement = row.locator('[data-qa*="negotiations-tag"], span[data-qa*="negotiations-item-"]').first();
        const hasTag = (await tagElement.count()) > 0;
        const tagText = hasTag ? (await tagElement.textContent())?.trim() ?? '' : '';
        const tagQa = hasTag ? (await tagElement.getAttribute('data-qa')) ?? '' : '';
        const status = normalizeScrapedNegotiationStatus(tagText, tagQa);

        const messageLocator = row
          .locator('[data-qa="negotiations-item-message"], [data-qa="negotiations-item-text"]')
          .first();
        const lastEmployerMessage =
          (await messageLocator.count()) > 0 ? (await messageLocator.textContent())?.trim() ?? null : null;

        results.push({
          vacancyId,
          status,
          lastEmployerMessage,
        });
      }

      return { data: results, error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        logger.info('Парсинг страницы откликов (/applicant/negotiations) отменен (браузер или контекст закрыт).');
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error('Ошибка headless-парсинга страницы откликов (/applicant/negotiations)', err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'NEGOTIATIONS_SCRAPE_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright negotiations scrape failed',
      });
      const message = err instanceof Error ? err.message : 'Headless Playwright negotiations scrape failed';
      return { data: null, error: message };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }

  public async bumpResumeInBrowser(sessionDir: string): Promise<SafeResult<'bumped' | 'not_ready'>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await this.acquireWarmContext(sessionDir);

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const navResp = await page.goto(`${this.webBaseUrl}/applicant/resumes`, { waitUntil: 'domcontentloaded' });
      if (navResp && navResp.status() >= 400) {
        await agentLogger.logPlaywrightError({
          traceId: agentLogger.createTraceId(),
          module: 'HH_BROWSER',
          action: 'RESUME_BUMP_NAVIGATION',
          error: new Error(`HTTP ${navResp.status()}`),
          page,
          httpStatus: navResp.status(),
          hint: 'HH.ru resume bump page returned HTTP >= 400; check cookies or anti-bot challenge',
        });
        return { data: null, error: `HTTP ${navResp.status()}: resume bump navigation failed` };
      }
      await page.waitForTimeout(1500);

      if (page.url().includes('/account/login')) {
        return {
          data: null,
          error: 'Сессия HH.ru не авторизована в браузере (редирект на /account/login).',
        };
      }

      let btn = page
        .locator(
          '[data-qa~="resume-update-button"], [data-qa~="resume-update-button_actions"], [data-qa*="resume-update-button"], button:has-text("Поднять в поиске")'
        )
        .first();

      await btn.waitFor({ state: 'visible', timeout: 3500 }).catch(() => null);

      let count = await btn.count().catch(() => 0);
      if (count === 0) {
        const firstResumeLink = page.locator('a[data-qa^="resume-card-link"], a[href*="/resume/"]').first();
        if ((await firstResumeLink.count().catch(() => 0)) > 0) {
          const href = await firstResumeLink.getAttribute('href').catch(() => null);
          if (href) {
            const targetUrl = href.startsWith('http') ? href : `${this.webBaseUrl}${href}`;
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
            await page.waitForTimeout(1500);
            btn = page
              .locator(
                '[data-qa~="resume-update-button"], [data-qa~="resume-update-button_actions"], [data-qa*="resume-update-button"], button:has-text("Поднять в поиске")'
              )
              .first();
            await btn.waitFor({ state: 'visible', timeout: 3500 }).catch(() => null);
            count = await btn.count().catch(() => 0);
          }
        }
      }

      if (count === 0 || !(await btn.isVisible().catch(() => false)) || !(await btn.isEnabled().catch(() => true))) {
        return { data: 'not_ready', error: null };
      }
      if ((await btn.getAttribute('disabled').catch(() => null)) !== null || (await btn.getAttribute('aria-disabled').catch(() => null)) === 'true') {
        return { data: 'not_ready', error: null };
      }

      await btn.click();
      await page.waitForTimeout(2000);

      logger.info('Резюме на HH.ru успешно поднято в поиске через Playwright.');
      return { data: 'bumped', error: null };
    } catch (err) {
      if (isBrowserClosedError(err)) {
        logger.info('Поднятие резюме через Playwright отменено (браузер или контекст закрыт).');
        return { data: null, error: 'ABORTED_BROWSER_CLOSED' };
      }
      logger.error('Ошибка поднятия резюме через Playwright', err);
      await agentLogger.logPlaywrightError({
        traceId: agentLogger.createTraceId(),
        module: 'HH_BROWSER',
        action: 'RESUME_BUMP_ERROR',
        error: err,
        page: currentPage ?? undefined,
        hint: 'Playwright resume bump failed',
      });
      const message = err instanceof Error ? err.message : 'Playwright resume bump failed';
      return { data: null, error: message };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await this.releaseWarmContext(context);
      }
    }
  }
}
