import path from 'node:path';
import { eq } from 'drizzle-orm';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, userProfiles, type ApplicationRecord } from '../../db/schema.ts';
import { createLogger } from '../../utils/logger.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';
import { agentLogger } from '../logger/index.ts';
import { HhVacancyApplyFsm, type IVacancyApplyFsm } from './hh-apply-fsm.ts';
import { closeActiveCaptchaSession, hasActiveCaptchaSession, retainActiveCaptchaSession } from './hh-captcha.detector.ts';
import {
  ApplyToVacancyInputSchema, buildHhSearchVacanciesUrl, formatSalaryText, HhVacancyFullResponseSchema,
  HhVacancySearchResponseSchema, isBrowserClosedError, normalizeScrapedNegotiationStatus, stripHtmlTags,
  VacancySearchQuerySchema, type ApplyToVacancyInput, type HhSalary, type HhVacancyFullResponse,
  type HhVacancySearchResponse, type HhVacancyShortItem, type ScrapedNegotiationItem, type VacancySearchQuery,
  type ValidatedVacancySearchQuery,
} from './hh-hybrid.schemas.ts';

const logger = createLogger('HhHybrid');

export {
  buildHhSearchVacanciesUrl, formatSalaryText, isBrowserClosedError, normalizeScrapedNegotiationStatus, stripHtmlTags, type ValidatedVacancySearchQuery,
};

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
}

export interface HhHybridOptions {
  readonly webBaseUrl?: string;
  readonly sessionDirName?: string;
  readonly customDriver?: PlaywrightBrowserDriver;
  readonly customApplyFsm?: IVacancyApplyFsm;
  readonly questionSolver?: (
    context: { vacancyId: string; vacancyUrl: string },
    questions: ReadonlyArray<EmployerQuestionItem>
  ) => Promise<SafeResult<EmployerQuestionAnswer[]>>;
}

export interface SyncNegotiationsSummary {
  readonly checkedCount: number;
  readonly updatedCount: number;
  readonly updatedRecords: ReadonlyArray<ApplicationRecord>;
}

export interface IHhHybridService {
  loginInteractive(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>>;
  confirmLogin?(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>>;
  checkAuthStatus?(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>>;
  searchVacancies(query: VacancySearchQuery): Promise<SafeResult<HhVacancySearchResponse>>;
  getVacancyDetails(vacancyId: string): Promise<SafeResult<ScrapedVacancyDetailsResult>>;
  applyToVacancy(input: ApplyToVacancyInput): Promise<SafeResult<boolean>>;
  syncNegotiations(): Promise<SafeResult<SyncNegotiationsSummary>>;
  bumpResume(): Promise<SafeResult<'bumped' | 'not_ready'>>;
  runWithSession?<T>(task: (sessionDir: string) => Promise<SafeResult<T>>): Promise<SafeResult<T>>;
}

function resolveSafeSessionDir(sessionDirName: string): string {
  const safeBase = path.basename(sessionDirName);
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, safeBase);

  if (!resolved.startsWith(workspaceRoot + path.sep)) {
    throw new Error('Invalid session directory boundary violation');
  }
  return resolved;
}

export class DefaultPlaywrightBrowserDriver implements PlaywrightBrowserDriver {
  private readonly webBaseUrl: string;
  private readonly applyFsm: IVacancyApplyFsm;
  private readonly questionSolver?: (
    context: { vacancyId: string; vacancyUrl: string },
    questions: ReadonlyArray<EmployerQuestionItem>
  ) => Promise<SafeResult<EmployerQuestionAnswer[]>>;

  private loginConfirmedResolver: (() => void) | null = null;

  constructor(
    webBaseUrl = 'https://hh.ru',
    applyFsm: IVacancyApplyFsm = new HhVacancyApplyFsm(),
    questionSolver?: (
      context: { vacancyId: string; vacancyUrl: string },
      questions: ReadonlyArray<EmployerQuestionItem>
    ) => Promise<SafeResult<EmployerQuestionAnswer[]>>
  ) {
    this.webBaseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
    this.applyFsm = applyFsm;
    this.questionSolver = questionSolver;
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

      const firstResumeLink = page.locator('a[data-qa^="resume-card-link"], a[href*="/resume/"]').first();
      const linkCount = await firstResumeLink.count();

      let hhResumeTitle = 'Основное резюме HH.ru';
      if (linkCount > 0) {
        const rawTitle = (await firstResumeLink.innerText().catch(() => ''))?.trim();
        if (rawTitle) {
          const firstLine = rawTitle.split('\n')[0]?.trim();
          if (firstLine) {
            hhResumeTitle = firstLine;
          }
        }
        const href = await firstResumeLink.getAttribute('href');
        if (href) {
          const targetUrl = href.startsWith('http') ? href : `${this.webBaseUrl}${href}`;
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500);
        }
      }

      const bodyText = await page.locator('main, [data-qa="resume-block"], body').first().innerText();
      const resumeRawText = bodyText.replace(/[ \t]+/g, ' ').trim();
      logger.info(`Профиль резюме успешно считан: "${hhResumeTitle}" (${resumeRawText.length} симв.).`);

      return {
        data: {
          hhResumeTitle,
          resumeRawText: resumeRawText.length >= 20 ? resumeRawText : hhResumeTitle,
        },
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
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      await page.goto(`${this.webBaseUrl}/applicant/resumes`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const url = page.url();
      if (url.includes('/account/login') || url.includes('/account/signup')) {
        logger.info('Сессия HH.ru не авторизована: редирект на /account/login.');
        return { data: null, error: 'HH_SESSION_NOT_LOGGED_IN' };
      }

      const firstResumeLink = page.locator('a[data-qa^="resume-card-link"], a[href*="/resume/"]').first();
      const linkCount = await firstResumeLink.count().catch(() => 0);

      let hhResumeTitle = 'Основное резюме HH.ru';
      let resumeHref: string | null = null;
      if (linkCount > 0) {
        const rawTitle = (await firstResumeLink.innerText().catch(() => ''))?.trim();
        if (rawTitle) {
          const firstLine = rawTitle.split('\n')[0]?.trim();
          if (firstLine) {
            hhResumeTitle = firstLine;
          }
        }
        const href = await firstResumeLink.getAttribute('href').catch(() => null);
        if (href) {
          resumeHref = href.startsWith('http') ? href : `${this.webBaseUrl}${href}`;
        }
      }

      if (resumeHref) {
        await page.goto(resumeHref, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
      }

      const bodyText = await page.locator('main, [data-qa="resume-block"], body').first().innerText().catch(() => '');
      const resumeRawText = bodyText.replace(/[ \t]+/g, ' ').trim();

      logger.info(`Сессия HH.ru подтверждена: "${hhResumeTitle}" (${resumeRawText.length} симв.).`);
      return {
        data: {
          hhResumeTitle,
          resumeRawText: resumeRawText.length >= 20 ? resumeRawText : hhResumeTitle,
        },
        error: null,
      };
    } catch (err) {
      logger.warn(`Ошибка проверки сессии HH.ru: ${err instanceof Error ? err.message : String(err)}`);
      return { data: null, error: err instanceof Error ? err.message : 'Session verification failed' };
    } finally {
      if (context) {
        await currentPage?.waitForTimeout(1000).catch(() => undefined);
        await context.close();
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

      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

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
          const href = link.getAttribute('href') ?? '';
          const match = /\/vacancy\/(\d+)/.exec(href);
          const id = match?.[1];
          if (!id || seenIds.has(id)) {
            continue;
          }

          const name = normalizeText(link.textContent);
          if (!name) {
            continue;
          }

          seenIds.add(id);
          const card =
            link.closest('[data-qa="vacancy-serp__vacancy"], [data-qa^="vacancy-serp__vacancy"]') ??
            link.parentElement?.parentElement ??
            null;

          const employerEl = card?.querySelector(
            '[data-qa="vacancy-serp__vacancy-employer-text"], [data-qa="vacancy-serp__vacancy-employer"]'
          );
          const employerName = normalizeText(employerEl?.textContent) || 'Unknown Company';

          const reqEl = card?.querySelector('[data-qa="vacancy-serp__vacancy_snippet_requirement"]');
          const respEl = card?.querySelector('[data-qa="vacancy-serp__vacancy_snippet_responsibility"]');

          const requirement = normalizeText(reqEl?.textContent) || null;
          const responsibility = normalizeText(respEl?.textContent) || null;

          extracted.push({
            id,
            name,
            alternate_url: `${baseUrl}/vacancy/${id}`,
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: employerName },
            snippet: {
              requirement,
              responsibility,
            },
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
        await context.close();
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

      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

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
        await context.close();
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
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

      const page = context.pages()[0] ?? (await context.newPage());
      currentPage = page;
      const fsmResult = await this.applyFsm.execute({
        page,
        vacancyId: input.vacancyId,
        vacancyUrl: input.vacancyUrl,
        resumeTitle: input.resumeTitle,
        coverLetter: input.coverLetter,
        webBaseUrl: this.webBaseUrl,
        skipForeignVacancies: input.skipForeignVacancies ?? true,
        questionSolver: this.questionSolver
          ? (questions) =>
              this.questionSolver!({ vacancyId: input.vacancyId, vacancyUrl: input.vacancyUrl }, questions)
          : undefined,
      });

      if (fsmResult.error || !fsmResult.data) {
        if (fsmResult.error === 'CAPTCHA_REQUIRED' && context) {
          retainActiveCaptchaSession(context, page, async () => {
            await this.applyFsm.completeAfterCaptcha?.({
              page,
              vacancyId: input.vacancyId,
              vacancyUrl: input.vacancyUrl,
              resumeTitle: input.resumeTitle,
              coverLetter: input.coverLetter,
              webBaseUrl: this.webBaseUrl,
              skipForeignVacancies: input.skipForeignVacancies ?? true,
            });
          });
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
        await context.close();
      }
    }
  }

  public async scrapeNegotiationsInBrowser(
    sessionDir: string
  ): Promise<SafeResult<ScrapedNegotiationItem[]>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

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
        await context.close();
      }
    }
  }

  public async bumpResumeInBrowser(sessionDir: string): Promise<SafeResult<'bumped' | 'not_ready'>> {
    let context: BrowserContext | null = null;
    let currentPage: Page | null = null;
    try {
      context = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 840 },
      });

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

      if (count === 0) {
        return { data: 'not_ready', error: null };
      }

      const isVisible = await btn.isVisible().catch(() => false);
      if (!isVisible) {
        return { data: 'not_ready', error: null };
      }

      const isEnabled = await btn.isEnabled().catch(() => true);
      if (!isEnabled) {
        return { data: 'not_ready', error: null };
      }

      const disabledAttr = await btn.getAttribute('disabled').catch(() => null);
      if (disabledAttr !== null) {
        return { data: 'not_ready', error: null };
      }

      const ariaDisabledAttr = await btn.getAttribute('aria-disabled').catch(() => null);
      if (ariaDisabledAttr === 'true') {
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
        await context.close();
      }
    }
  }
}

export class HhHybridService implements IHhHybridService {
  private readonly configStore: IConfigStore;
  private readonly db: AppDatabase;
  private readonly sessionDir: string;
  private readonly browserDriver: PlaywrightBrowserDriver;
  private isInteractiveLoginActive = false;
  private browserMutexPromise: Promise<void> = Promise.resolve();

  constructor(configStore: IConfigStore, db: AppDatabase, options?: HhHybridOptions) {
    this.configStore = configStore;
    this.db = db;
    this.sessionDir = resolveSafeSessionDir(options?.sessionDirName ?? 'hh-session');
    this.browserDriver =
      options?.customDriver ??
      new DefaultPlaywrightBrowserDriver(options?.webBaseUrl, options?.customApplyFsm, options?.questionSolver);
  }

  public async loginInteractive(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>> {
    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Окно входа в HH.ru уже открыто. Завершите авторизацию в браузере.' };
    }

    this.isInteractiveLoginActive = true;
    try {
      return await this.runWithBrowserLock(async () => {
        const result = await this.browserDriver.loginAndScrapeResume(this.sessionDir);
        if (result.error || !result.data) {
          this.configStore.set('HH_IS_LOGGED_IN', 'false');
          return { data: null, error: result.error ?? 'Не удалось выполнить вход в HH.ru' };
        }

        this.configStore.set('HH_IS_LOGGED_IN', 'true');
        this.saveUserProfile(result.data.hhResumeTitle, result.data.resumeRawText);
        return { data: result.data, error: null };
      });
    } finally {
      this.isInteractiveLoginActive = false;
    }
  }

  public async confirmLogin(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>> {
    if (this.isInteractiveLoginActive) {
      this.browserDriver.notifyLoginConfirmed?.();
      return { data: null, error: 'CHECKING_IN_PROGRESS' };
    }
    return this.checkAuthStatus();
  }

  public async checkAuthStatus(): Promise<SafeResult<{ hhResumeTitle: string; resumeRawText: string }>> {
    return this.runWithBrowserLock(async () => {
      const driver = this.browserDriver;
      const verifyFn = driver.verifySessionAndScrapeResume
        ? driver.verifySessionAndScrapeResume.bind(driver)
        : null;

      if (!verifyFn) {
        return { data: null, error: 'Session verification not supported by driver' };
      }

      const result = await verifyFn(this.sessionDir);
      if (result.error || !result.data) {
        this.configStore.set('HH_IS_LOGGED_IN', 'false');
        return { data: null, error: result.error ?? 'Сессия HH.ru не авторизована' };
      }

      this.configStore.set('HH_IS_LOGGED_IN', 'true');
      this.saveUserProfile(result.data.hhResumeTitle, result.data.resumeRawText);
      return { data: result.data, error: null };
    });
  }

  private saveUserProfile(hhResumeTitle: string, resumeRawText: string): void {
    const existingProfile = this.db.select().from(userProfiles).limit(1).get();
    if (existingProfile) {
      this.db
        .update(userProfiles)
        .set({
          hhResumeTitle,
          resumeRawText,
        })
        .where(eq(userProfiles.id, existingProfile.id))
        .run();
    } else {
      this.db
        .insert(userProfiles)
        .values({
          hhResumeTitle,
          resumeRawText,
          customPromptRules: null,
        })
        .run();
    }
  }

  public async searchVacancies(query: VacancySearchQuery): Promise<SafeResult<HhVacancySearchResponse>> {
    const parsedQuery = VacancySearchQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      return { data: null, error: parsedQuery.error.issues[0]?.message ?? 'Invalid vacancy search parameters' };
    }

    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }

    return this.runWithBrowserLock(async () => {
      return this.browserDriver.searchVacanciesInBrowser(this.sessionDir, parsedQuery.data);
    });
  }

  public async getVacancyDetails(vacancyId: string): Promise<SafeResult<ScrapedVacancyDetailsResult>> {
    const trimmedId = vacancyId.trim();
    if (!trimmedId) {
      return { data: null, error: 'Vacancy ID cannot be empty' };
    }

    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }

    return this.runWithBrowserLock(async () => {
      return this.browserDriver.scrapeVacancyDetailsInBrowser(this.sessionDir, trimmedId);
    });
  }

  public async applyToVacancy(input: ApplyToVacancyInput): Promise<SafeResult<boolean>> {
    const parsedInput = ApplyToVacancyInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return { data: null, error: parsedInput.error.issues[0]?.message ?? 'Invalid application payload' };
    }

    if (this.configStore.get('HH_IS_LOGGED_IN').data !== 'true') {
      return { data: null, error: 'Сессия HH.ru не авторизована. Сначала выполните вход через браузер.' };
    }

    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }

    return this.runWithBrowserLock(async () => {
      const result = await this.browserDriver.applyInBrowser(this.sessionDir, parsedInput.data);
      if (result.error?.includes('/account/login')) {
        this.configStore.set('HH_IS_LOGGED_IN', 'false');
      }
      return result;
    });
  }

  public async syncNegotiations(): Promise<SafeResult<SyncNegotiationsSummary>> {
    if (this.configStore.get('HH_IS_LOGGED_IN').data !== 'true') {
      return { data: null, error: 'Сессия HH.ru не авторизована.' };
    }

    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }

    return this.runWithBrowserLock(async () => {
      const scrapedResult = await this.browserDriver.scrapeNegotiationsInBrowser(this.sessionDir);
      if (scrapedResult.error || !scrapedResult.data) {
        if (scrapedResult.error?.includes('/account/login')) {
          this.configStore.set('HH_IS_LOGGED_IN', 'false');
        }
        return { data: null, error: scrapedResult.error ?? 'Failed to scrape negotiations' };
      }

      const updatedRecords = scrapedResult.data
        .map((item) => this.reconcileScrapedItem(item))
        .filter((x): x is ApplicationRecord => x !== null);

      return {
        data: {
          checkedCount: scrapedResult.data.length,
          updatedCount: updatedRecords.length,
          updatedRecords,
        },
        error: null,
      };
    });
  }

  public async bumpResume(): Promise<SafeResult<'bumped' | 'not_ready'>> {
    if (this.configStore.get('HH_IS_LOGGED_IN').data !== 'true') {
      return { data: null, error: 'Сессия HH.ru не авторизована. Сначала выполните вход через браузер.' };
    }

    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }

    return this.runWithBrowserLock(async () => {
      const result = await this.browserDriver.bumpResumeInBrowser(this.sessionDir);
      if (result.error?.includes('/account/login')) {
        this.configStore.set('HH_IS_LOGGED_IN', 'false');
      }
      return result;
    });
  }

  public async runWithSession<T>(
    task: (sessionDir: string) => Promise<SafeResult<T>>
  ): Promise<SafeResult<T>> {
    if (this.configStore.get('HH_IS_LOGGED_IN').data !== 'true') {
      return { data: null, error: 'Сессия HH.ru не авторизована.' };
    }
    if (this.isInteractiveLoginActive) {
      return { data: null, error: 'Браузер занят интерактивным входом пользователя.' };
    }
    return this.runWithBrowserLock(async () => {
      const result = await task(this.sessionDir);
      if (result.error?.includes('/account/login')) {
        this.configStore.set('HH_IS_LOGGED_IN', 'false');
      }
      return result;
    });
  }

  private async runWithBrowserLock<T>(task: () => Promise<SafeResult<T>>): Promise<SafeResult<T>> {
    const previousLock = this.browserMutexPromise;
    let releaseLock!: () => void;
    this.browserMutexPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;
    try {
      if (hasActiveCaptchaSession()) {
        return { data: null, error: 'Браузер ожидает решения капчи.' };
      }
      return await task();
    } finally {
      releaseLock();
    }
  }

  private reconcileScrapedItem(item: ScrapedNegotiationItem): ApplicationRecord | null {
    const existing = this.db
      .select()
      .from(applicationRecords)
      .where(eq(applicationRecords.vacancyId, item.vacancyId))
      .limit(1)
      .get();

    if (!existing) {
      return null;
    }

    const statusChanged = existing.status !== item.status;
    const nextMessage = item.lastEmployerMessage ?? existing.lastEmployerMessage;
    const messageChanged = nextMessage !== existing.lastEmployerMessage;

    if (!statusChanged && !messageChanged) {
      return null;
    }

    const nowIso = new Date().toISOString();
    this.db
      .update(applicationRecords)
      .set({
        status: item.status,
        lastEmployerMessage: nextMessage,
        isNotified: false,
        updatedAt: nowIso,
      })
      .where(eq(applicationRecords.id, existing.id))
      .run();

    return (
      this.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.id, existing.id))
        .limit(1)
        .get() ?? null
    );
  }
}
