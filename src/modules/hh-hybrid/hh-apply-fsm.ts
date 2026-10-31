import type { Page, Frame } from 'playwright';
import type { SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';
import { createLogger } from '../../utils/logger.ts';
import {
  CAPTCHA_REQUIRED_ERROR,
  HhCaptchaDetector,
  type CaptchaChallengeSnapshot,
  type IHhCaptchaDetector,
} from './hh-captcha.detector.ts';

const logger = createLogger('HhHybrid');

export type EmployerQuestionSolver = (
  questions: ReadonlyArray<EmployerQuestionItem>
) => Promise<SafeResult<EmployerQuestionAnswer[]>>;

export const FOREIGN_VACANCY_ERROR = 'FOREIGN_VACANCY' as const;

export interface ApplyWorkflowInput {
  readonly page: Page;
  readonly vacancyId: string;
  readonly vacancyUrl: string;
  readonly resumeTitle?: string | null;
  readonly coverLetter?: string | null;
  readonly webBaseUrl?: string;
  readonly questionSolver?: EmployerQuestionSolver;
  readonly skipForeignVacancies?: boolean;
}

export interface ApplyWorkflowOutput {
  readonly applied: boolean;
  readonly alreadyApplied?: boolean;
  readonly coverLetterAttached: boolean;
}

export interface IVacancyApplyFsm {
  execute(input: ApplyWorkflowInput): Promise<SafeResult<ApplyWorkflowOutput>>;
  completeAfterCaptcha?(input: ApplyWorkflowInput): Promise<SafeResult<ApplyWorkflowOutput>>;
  getLastCaptchaSnapshot?(): CaptchaChallengeSnapshot | null;
}

export class HhVacancyApplyFsm implements IVacancyApplyFsm {
  private readonly captchaDetector: IHhCaptchaDetector;

  constructor(captchaDetector?: IHhCaptchaDetector) {
    this.captchaDetector = captchaDetector ?? new HhCaptchaDetector();
  }

  public getLastCaptchaSnapshot(): CaptchaChallengeSnapshot | null {
    return this.captchaDetector.getLastSnapshot?.() ?? null;
  }

  public async completeAfterCaptcha(
    input: ApplyWorkflowInput
  ): Promise<SafeResult<ApplyWorkflowOutput>> {
    const { page, vacancyId, resumeTitle, coverLetter, webBaseUrl } = input;
    const base = webBaseUrl ?? 'https://hh.ru';
    const skipForeign = input.skipForeignVacancies ?? true;

    const reloc1 = await this.confirmRelocationWarningIfPresent(page, skipForeign);
    if (reloc1.error === FOREIGN_VACANCY_ERROR) {
      return { data: null, error: FOREIGN_VACANCY_ERROR };
    }
    await this.selectResumeIfPresent(page, resumeTitle);

    let coverLetterAttached = false;
    if (coverLetter && coverLetter.trim().length > 0) {
      const letterRes = await this.attachCoverLetterOnPage(page, coverLetter, skipForeign);
      if (letterRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      coverLetterAttached = letterRes.data ?? false;
    }

    if (!coverLetterAttached) {
      const modalRes = await this.submitModalIfPresent(page, skipForeign);
      if (modalRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      const reloc2 = await this.confirmRelocationWarningIfPresent(page, skipForeign);
      if (reloc2.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
    }

    if (!(await this.verifySubmissionOutcome(page))) {
      await this.dispatchInitialApplication(page, resumeTitle).catch(() => undefined);
      const reloc3 = await this.confirmRelocationWarningIfPresent(page, skipForeign);
      if (reloc3.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      const modalRes2 = await this.submitModalIfPresent(page, skipForeign);
      if (modalRes2.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
    }

    if (coverLetter && coverLetter.trim().length > 0) {
      if (!coverLetterAttached) {
        const secondAttempt = await this.attachCoverLetterOnPage(page, coverLetter, skipForeign);
        if (secondAttempt.error === FOREIGN_VACANCY_ERROR) {
          return { data: null, error: FOREIGN_VACANCY_ERROR };
        }
        coverLetterAttached = secondAttempt.data ?? false;
      }

      if (!coverLetterAttached) {
        coverLetterAttached = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, false);
      } else {
        const chatFixed = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, true);
        if (chatFixed) {
          coverLetterAttached = true;
        }
      }
    }

    return {
      data: { applied: true, alreadyApplied: false, coverLetterAttached },
      error: null,
    };
  }

  public async execute(input: ApplyWorkflowInput): Promise<SafeResult<ApplyWorkflowOutput>> {
    const { page, vacancyId, vacancyUrl, resumeTitle, coverLetter, webBaseUrl } = input;
    const base = webBaseUrl ?? 'https://hh.ru';
    const skipForeign = input.skipForeignVacancies ?? true;

    await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded' });

    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const preFlightCheck = await this.verifySessionAndState(page);
    if (preFlightCheck.error) {
      return { data: null, error: preFlightCheck.error };
    }

    if (preFlightCheck.data?.isAlreadyResponded) {
      if (coverLetter && coverLetter.trim().length > 0) {
        const inlineLetter = await this.attachCoverLetterOnPage(page, coverLetter);
        if (inlineLetter.data) {
          return {
            data: { applied: true, alreadyApplied: false, coverLetterAttached: true },
            error: null,
          };
        }
        if (typeof page.frames === 'function') {
          const chatAttached = await this.attachCoverLetterViaChat(
            page,
            vacancyId,
            coverLetter,
            base,
            true
          );
          if (chatAttached) {
            return {
              data: { applied: true, alreadyApplied: false, coverLetterAttached: true },
              error: null,
            };
          }
        }
      }
      return {
        data: {
          applied: false,
          alreadyApplied: true,
          coverLetterAttached: false,
        },
        error: null,
      };
    }

    const dispatchRes = await this.dispatchInitialApplication(page, resumeTitle);
    if (dispatchRes.error) {
      return { data: null, error: dispatchRes.error };
    }

    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const relocRes = await this.confirmRelocationWarningIfPresent(page, skipForeign);
    if (relocRes.error === FOREIGN_VACANCY_ERROR) {
      return { data: null, error: FOREIGN_VACANCY_ERROR };
    }
    if (relocRes.data) {
      await this.waitForPostClickState(page);
      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }
      await this.selectResumeIfPresent(page, resumeTitle);
    }

    if (await this.checkEmployerQuestionsRequired(page)) {
      if ((await this.hasHardTestOrBlocker(page)) || !input.questionSolver) {
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }

      const scrapedQuestions = await this.scrapeEmployerQuestions(page);
      if (scrapedQuestions.length === 0) {
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }

      const solvedRes = await input.questionSolver(scrapedQuestions);
      if (solvedRes.error || !solvedRes.data || solvedRes.data.length === 0) {
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }

      const filled = await this.fillEmployerQuestionAnswers(page, scrapedQuestions, solvedRes.data);
      if (!filled) {
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }

      let coverLetterAttached = false;
      if (coverLetter && coverLetter.trim().length > 0) {
        const letterRes = await this.attachCoverLetterOnPage(page, coverLetter);
        coverLetterAttached = letterRes.data ?? false;
      }

      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }

      await this.submitQuestionsFormOrModal(page);
      const relocResQ = await this.confirmRelocationWarningIfPresent(page, skipForeign);
      if (relocResQ.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }

      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }

      const verified = await this.verifySubmissionOutcome(page);
      if (!verified) {
        if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
          return { data: null, error: CAPTCHA_REQUIRED_ERROR };
        }
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }

      if (coverLetter && coverLetter.trim().length > 0) {
        if (!coverLetterAttached) {
          coverLetterAttached = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, false);
        } else {
          const chatFixed = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, true);
          if (chatFixed) {
            coverLetterAttached = true;
          }
        }
      }

      return {
        data: {
          applied: true,
          alreadyApplied: false,
          coverLetterAttached,
        },
        error: null,
      };
    }

    let coverLetterAttached = false;
    if (coverLetter && coverLetter.trim().length > 0) {
      const letterRes = await this.attachCoverLetterOnPage(page, coverLetter, skipForeign);
      if (letterRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      if (letterRes.error) {
        return { data: null, error: letterRes.error };
      }
      coverLetterAttached = letterRes.data ?? false;
    }

    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const relocResMid = await this.confirmRelocationWarningIfPresent(page, skipForeign);
    if (relocResMid.error === FOREIGN_VACANCY_ERROR) {
      return { data: null, error: FOREIGN_VACANCY_ERROR };
    }
    if (relocResMid.data) {
      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }
    }

    if (!coverLetterAttached) {
      const modalSubmitRes = await this.submitModalIfPresent(page, skipForeign);
      if (modalSubmitRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      if (modalSubmitRes.error) {
        return { data: null, error: modalSubmitRes.error };
      }
    }

    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const relocResFin = await this.confirmRelocationWarningIfPresent(page, skipForeign);
    if (relocResFin.error === FOREIGN_VACANCY_ERROR) {
      return { data: null, error: FOREIGN_VACANCY_ERROR };
    }

    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const verified = await this.verifySubmissionOutcome(page);
    if (!verified) {
      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }
      if ((await this.checkEmployerQuestionsRequired(page)) || (await this.hasFormValidationErrors(page))) {
        return {
          data: null,
          error: 'QUESTIONS_REQUIRED',
        };
      }
      return {
        data: null,
        error: 'Post-submission verification failed: no response confirmation element found in DOM',
      };
    }

    if (coverLetter && coverLetter.trim().length > 0) {
      if (!coverLetterAttached) {
        const secondAttempt = await this.attachCoverLetterOnPage(page, coverLetter);
        coverLetterAttached = secondAttempt.data ?? false;
      }

      if (!coverLetterAttached) {
        coverLetterAttached = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, false);
      } else {
        const chatFixed = await this.attachCoverLetterViaChat(page, vacancyId, coverLetter, base, true);
        if (chatFixed) {
          coverLetterAttached = true;
        }
      }
    }

    return {
      data: {
        applied: true,
        alreadyApplied: false,
        coverLetterAttached,
      },
      error: null,
    };
  }

  private async verifySessionAndState(
    page: Page
  ): Promise<SafeResult<{ isAlreadyResponded: boolean }>> {
    if (page.url().includes('/account/login')) {
      return {
        data: null,
        error: 'HH.ru session expired: redirected to login page',
      };
    }

    const alreadyRespondedLocators = [
      page.locator('[data-qa="vacancy-response-link-view-topic"]'),
      page.locator('[data-qa="responded-success-attach-cover-letter"]'),
      page.locator('[data-qa="vacancy-response-link-top"]:has-text("Вы откликнулись")'),
      page.locator('text="Вы откликнулись"'),
    ];

    for (const locator of alreadyRespondedLocators) {
      const count = await locator.count();
      if (count > 0 && (await locator.first().isVisible())) {
        return { data: { isAlreadyResponded: true }, error: null };
      }
    }

    return { data: { isAlreadyResponded: false }, error: null };
  }

  private async dispatchInitialApplication(
    page: Page,
    resumeTitle?: string | null
  ): Promise<SafeResult<boolean>> {
    const respondButton = page
      .locator('[data-qa="vacancy-response-link-top"], [data-qa="vacancy-response-link-bottom"]')
      .first();

    const buttonCount = await respondButton.count();
    if (buttonCount === 0) {
      return {
        data: null,
        error: 'Vacancy response button not found on page',
      };
    }

    await respondButton.click();
    await this.waitForPostClickState(page);
    await this.selectResumeIfPresent(page, resumeTitle);

    return { data: true, error: null };
  }

  private async selectResumeIfPresent(page: Page, resumeTitle?: string | null): Promise<void> {
    if (!resumeTitle) {
      return;
    }

    const resumeOption = page.locator('label, [data-qa="resume-title"]', { hasText: resumeTitle }).first();
    const resumeCount = await resumeOption.count().catch(() => 0);
    if (resumeCount > 0 && (await resumeOption.isVisible().catch(() => false))) {
      await resumeOption.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
  }

  private async waitForPostClickState(page: Page): Promise<void> {
    const candidateSelectors = [
      '[data-qa="account-captcha-picture"]',
      '[data-qa="account-captcha-input"]',
      'text="Пройдите капчу"',
      '[data-qa="relocation-warning-confirm"]',
      'button:has-text("Все равно откликнуться")',
      '[data-qa="vacancy-response-submit-popup"]',
      '[data-qa="responded-success-attach-cover-letter"]',
      'textarea[data-qa="vacancy-response-popup-form-letter-input"]',
      '[data-qa="vacancy-response-link-view-topic"]',
      'text="Вы откликнулись"',
    ];

    await Promise.race([
      ...candidateSelectors.map((sel) =>
        page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
      ),
      page.waitForTimeout(2000),
    ]);
  }

  private async checkForeignCountryWarning(page: Page): Promise<boolean> {
    const dialogLocators = [
      page.locator('[data-qa="relocation-warning-confirm"]'),
      page.locator('[data-qa="relocation-warning"]'),
      page.locator('[data-qa*="relocation"]'),
      page.locator('[role="dialog"]'),
      page.locator('.bloko-modal'),
    ];

    let hasAnyDialog = false;
    for (const loc of dialogLocators) {
      if (!loc || typeof loc.count !== 'function') continue;
      const count = await loc.count().catch(() => 0);
      if (count > 0 && (await loc.first().isVisible().catch(() => false))) {
        hasAnyDialog = true;
        break;
      }
    }

    if (!hasAnyDialog) {
      return false;
    }

    const foreignSelectors = [
      'text="другой стране"',
      'text="другая страна"',
      'text="другую страну"',
      'text="в другой стране"',
      '[data-qa*="relocation-warning"]:has-text("стран")',
      '[role="dialog"]:has-text("стран")',
      '.bloko-modal:has-text("стран")',
    ];

    for (const sel of foreignSelectors) {
      const loc = page.locator(sel).first();
      if (loc && typeof loc.count !== 'function') {
        continue;
      }
      const count = await loc.count().catch(() => 0);
      if (count > 0 && (await loc.isVisible().catch(() => false))) {
        return true;
      }
    }

    if (typeof page.evaluate === 'function') {
      const evalResult = await page
        .evaluate(() => {
          const dialogs = document.querySelectorAll(
            '[role="dialog"], .bloko-modal, [data-qa*="relocation-warning"], [data-qa*="warning-modal"]'
          );
          const searchScope = dialogs.length > 0 ? Array.from(dialogs) : [document.body];
          for (const el of searchScope) {
            if (!el) continue;
            const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase();
            const hasCountryMention =
              text.includes('другой стране') ||
              text.includes('другая страна') ||
              text.includes('другую страну') ||
              text.includes('в другой стране');
            if (hasCountryMention) {
              return true;
            }
          }
          return false;
        })
        .catch(() => false);

      return evalResult === true;
    }

    return false;
  }

  private async confirmRelocationWarningIfPresent(
    page: Page,
    skipForeignVacancies = true
  ): Promise<SafeResult<boolean>> {
    if (skipForeignVacancies) {
      const isForeign = await this.checkForeignCountryWarning(page);
      if (isForeign) {
        logger.info(
          'Обнаружено предупреждение о нахождении работодателя или вакансии в другой стране. Пропуск вакансии.'
        );
        const closeBtn = page
          .locator(
            '[data-qa="relocation-warning-cancel"], [data-qa="modal-close"], button[aria-label*="закрыть" i], [data-qa*="close"]'
          )
          .first();
        if (closeBtn && typeof closeBtn.count === 'function' && (await closeBtn.count().catch(() => 0)) > 0) {
          await closeBtn.click().catch(() => undefined);
        }
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
    }

    const relocSelectors = [
      '[data-qa="relocation-warning-confirm"]',
      'button:has-text("Все равно откликнуться")',
    ];

    for (const selector of relocSelectors) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0 && (await locator.isVisible().catch(() => false))) {
        await locator.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        return { data: true, error: null };
      }
    }

    return { data: false, error: null };
  }

  private async attachCoverLetterOnPage(
    page: Page,
    coverLetter: string,
    skipForeignVacancies = true
  ): Promise<SafeResult<boolean>> {
    const inputLocator = page
      .locator(
        'textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[data-qa="vacancy-response-letter-informer-input"], textarea[name="text"], textarea[name="letter"]'
      )
      .first();

    const isVisibleInitially = (await inputLocator.count()) > 0 && (await inputLocator.isVisible());
    if (!isVisibleInitially) {
      const opened = await this.triggerCoverLetterModal(page);
      if (!opened) {
        return { data: false, error: null };
      }
    }

    const inputReady = await inputLocator.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!inputReady) {
      return { data: false, error: null };
    }

    await inputLocator.fill(coverLetter);
    await page.waitForTimeout(400);

    const submitButton = page
      .locator(
        '[data-qa="vacancy-response-letter-submit"], [data-qa="vacancy-response-submit-popup"], button[type="submit"]:has-text("Отправить"), button:has-text("Отправить"), button:has-text("Прикрепить"), button:has-text("Сохранить")'
      )
      .first();

    const submitReady = await submitButton.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!submitReady) {
      return { data: false, error: null };
    }

    try {
      await submitButton.click({ timeout: 5000 });
    } catch {
      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }
      const relocRes = await this.confirmRelocationWarningIfPresent(page, skipForeignVacancies);
      if (relocRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      if (relocRes.data) {
        if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
          return { data: null, error: CAPTCHA_REQUIRED_ERROR };
        }
      }
      await submitButton.click({ force: true, timeout: 3000 }).catch(() => undefined);
    }

    const isHidden = await inputLocator
      .waitFor({ state: 'hidden', timeout: 4000 })
      .then(() => true)
      .catch(() => false);

    if (!isHidden) {
      logger.warn('[HhHybrid] Поле ввода сопроводительного письма осталось видимым после отправки.');
      return { data: false, error: null };
    }

    await page.waitForTimeout(1500);
    return { data: true, error: null };
  }

  private async triggerCoverLetterModal(page: Page): Promise<boolean> {
    const toggleSelectors = [
      '[data-qa="responded-success-attach-cover-letter"]',
      '[data-qa="vacancy-response-letter-toggle"]',
      'button:has-text("сопроводительное")',
      'a:has-text("сопроводительное")',
    ];

    for (const selector of toggleSelectors) {
      const toggle = page.locator(selector).first();
      const count = await toggle.count().catch(() => 0);
      if (count > 0 && (await toggle.isVisible().catch(() => false))) {
        await toggle.click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(800);
        return true;
      }
    }

    const firstToggle = page.locator(toggleSelectors.join(', ')).first();
    const appeared = await firstToggle.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false);
    if (appeared && (await firstToggle.count().catch(() => 0)) > 0 && (await firstToggle.isVisible().catch(() => false))) {
      await firstToggle.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      return true;
    }

    return false;
  }

  private async submitModalIfPresent(page: Page, skipForeignVacancies = true): Promise<SafeResult<boolean>> {
    if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
      return { data: null, error: CAPTCHA_REQUIRED_ERROR };
    }

    const modalSubmit = page.locator('[data-qa="vacancy-response-submit-popup"]').first();
    const count = await modalSubmit.count().catch(() => 0);
    if (count === 0 || !(await modalSubmit.isVisible().catch(() => false))) {
      return { data: false, error: null };
    }

    try {
      await modalSubmit.click({ timeout: 5000 });
    } catch {
      if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
        return { data: null, error: CAPTCHA_REQUIRED_ERROR };
      }
      const relocRes = await this.confirmRelocationWarningIfPresent(page, skipForeignVacancies);
      if (relocRes.error === FOREIGN_VACANCY_ERROR) {
        return { data: null, error: FOREIGN_VACANCY_ERROR };
      }
      if (relocRes.data) {
        if ((await this.captchaDetector.detectCaptchaOnPage(page)).detected) {
          return { data: null, error: CAPTCHA_REQUIRED_ERROR };
        }
      }
      await modalSubmit.click({ force: true, timeout: 3000 }).catch(() => undefined);
    }

    await page.waitForTimeout(1200);
    return { data: true, error: null };
  }

  private async verifySubmissionOutcome(page: Page): Promise<boolean> {
    const confirmationLocators = [
      page.locator('[data-qa="vacancy-response-link-view-topic"]'),
      page.locator('[data-qa="responded-success-attach-cover-letter"]'),
      page.locator('[data-qa="vacancy-response-link-top"]:has-text("Вы откликнулись")'),
      page.locator('text="Вы откликнулись"'),
      page.locator('text="Отклик отправлен"'),
      page.locator('text="Перейти к переписке"'),
      page.locator('[data-qa="responses-streak"]'),
    ];

    for (const locator of confirmationLocators) {
      const count = await locator.count().catch(() => 0);
      if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
        return true;
      }
    }

    await Promise.race([
      ...confirmationLocators.map((loc) =>
        loc.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
      ),
      page.waitForTimeout(3000),
    ]);

    for (const locator of confirmationLocators) {
      const count = await locator.count().catch(() => 0);
      if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
        return true;
      }
    }

    return false;
  }

  private async isHiddenResumeWarningBlocking(page: Page): Promise<boolean> {
    const hiddenWarnLoc = page.locator('[data-qa="hidden-resume-warning"]');
    const warnCount =
      hiddenWarnLoc && typeof hiddenWarnLoc.count === 'function'
        ? await hiddenWarnLoc.count().catch(() => 0)
        : 0;
    if (warnCount > 0) {
      const hiddenWarn = typeof hiddenWarnLoc.first === 'function' ? hiddenWarnLoc.first() : hiddenWarnLoc;
      if (typeof hiddenWarn.boundingBox === 'function') {
        const box = await hiddenWarn.boundingBox().catch(() => null);
        return Boolean(box && box.height > 5);
      }
      return await hiddenWarn.isVisible().catch(() => false);
    }

    const legacyText = page.locator('text="Чтобы откликнуться на эту вакансию, поменяйте видимость резюме"');
    if (legacyText && typeof legacyText.count === 'function') {
      const count = await legacyText.count().catch(() => 0);
      if (count > 0 && (await legacyText.first().isVisible().catch(() => false))) {
        return true;
      }
    }

    return false;
  }

  private async checkEmployerQuestionsRequired(page: Page): Promise<boolean> {
    if (await this.isHiddenResumeWarningBlocking(page)) {
      return true;
    }

    const questionIndicators = [
      'textarea[name^="task_"]',
      'input[name^="task_"]',
      'text="Для отклика необходимо ответить на несколько вопросов работодателя"',
      'text="Ответьте на вопросы"',
      '[data-qa="test-task-input"]',
      '[data-qa="vacancy-response-popup-questions"]',
    ];

    for (const sel of questionIndicators) {
      const locator = page.locator(sel);
      if (!locator || typeof locator.count !== 'function') {
        continue;
      }
      const count = await locator.count();
      if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
        return true;
      }
    }

    return false;
  }

  private async hasFormValidationErrors(page: Page): Promise<boolean> {
    const errorSelectors = [
      '[class*="error"]:has-text("Писать тут")',
      '[data-qa*="error"]:has-text("Писать тут")',
      '[class*="error"]:has-text("Заполните")',
      '[data-qa*="error"]:has-text("Заполните")',
      'text="Писать тут"',
    ];

    for (const sel of errorSelectors) {
      const locator = page.locator(sel);
      if (!locator || typeof locator.count !== 'function') {
        continue;
      }
      const count = await locator.count();
      if (count > 0 && (await locator.first().isVisible().catch(() => false))) {
        return true;
      }
    }

    return false;
  }

  private async attachCoverLetterViaChat(
    page: Page,
    vacancyId: string,
    coverLetter: string,
    webBaseUrl: string,
    requireUnattachedAction = false
  ): Promise<boolean> {
    try {
      logger.info(`[HhHybrid] Попытка отправки сопроводительного письма через чат для вакансии ${vacancyId}...`);

      const viewTopicBtn = page.locator('[data-qa="vacancy-response-link-view-topic"]').first();
      let hasChatOnPage = (await viewTopicBtn.count().catch(() => 0)) > 0;
      if (!hasChatOnPage) {
        hasChatOnPage = await viewTopicBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      }

      if (hasChatOnPage) {
        logger.info(`[HhHybrid] Кнопка чата найдена на странице вакансии ${vacancyId}. Открытие чата...`);
        await viewTopicBtn.click().catch(() => undefined);
        const sentOnPage = await this.waitForChatAndSendLetter(
          page,
          coverLetter,
          requireUnattachedAction
        );
        if (sentOnPage) {
          logger.info(`[HhHybrid] Сопроводительное письмо успешно отправлено со страницы вакансии ${vacancyId}.`);
          return true;
        }
        if (requireUnattachedAction) {
          return false;
        }
      }

      logger.info(`[HhHybrid] Переход в /applicant/negotiations для отправки письма к вакансии ${vacancyId}...`);
      await page.goto(`${webBaseUrl}/applicant/negotiations`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const rowByVacancy = page
        .locator('[data-qa="negotiations-item"]')
        .filter({ has: page.locator(`a[href*="/vacancy/${vacancyId}"]`) })
        .first();

      let targetRow = (await rowByVacancy.count().catch(() => 0)) > 0 ? rowByVacancy : null;
      if (!targetRow) {
        const firstRow = page.locator('[data-qa="negotiations-item"]').first();
        if ((await firstRow.count().catch(() => 0)) > 0) {
          targetRow = firstRow;
        }
      }

      if (!targetRow) {
        logger.warn(`[HhHybrid] Не найден элемент отклика в /applicant/negotiations для вакансии ${vacancyId}.`);
        return false;
      }

      const openChatBtn = targetRow
        .locator('[data-qa="open_chat"], a:has-text("Перейти в чат"), [data-qa="vacancy-response-link-view-topic"]')
        .first();

      const openChatReady = await openChatBtn.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      if (!openChatReady) {
        logger.warn(`[HhHybrid] Кнопка чата в строке отклика не найдена.`);
        return false;
      }

      await openChatBtn.click().catch(() => undefined);
      const sentInNegotiations = await this.waitForChatAndSendLetter(
        page,
        coverLetter,
        requireUnattachedAction
      );
      if (sentInNegotiations) {
        logger.info(`[HhHybrid] Сопроводительное письмо успешно отправлено через чат в /applicant/negotiations.`);
        return true;
      }

      return false;
    } catch (err) {
      logger.warn(`[HhHybrid] Ошибка отправки сопроводительного письма через чат: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async waitForChatAndSendLetter(
    page: Page,
    coverLetter: string,
    requireUnattachedAction = false
  ): Promise<boolean> {
    try {
      let chatFrame: Frame | null = null;
      const startWait = Date.now();
      while (Date.now() - startWait < 12000) {
        const found = page.frames().find((f) => f.url().includes('chatik.hh.ru'));
        if (found) {
          chatFrame = found;
          break;
        }
        await page.waitForTimeout(500);
      }

      if (!chatFrame) {
        logger.warn(`[HhHybrid] Фрейм chatik.hh.ru не обнаружен за 12 секунд.`);
        return false;
      }

      const addCoverBtn = chatFrame
        .locator(
          '[data-qa="chatik-chat-message-applicant-action"], button:has-text("Добавить сопроводительное")'
        )
        .first();
      const addCoverVisible = await addCoverBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      if (addCoverVisible) {
        logger.info(`[HhHybrid] Нажата кнопка "Добавить сопроводительное" в чате.`);
        await addCoverBtn.click().catch(() => undefined);
        await page.waitForTimeout(600);
      } else if (requireUnattachedAction) {
        return false;
      }

      const input = chatFrame.locator('textarea[data-qa="text-input"]').first();
      const inputReady = await input.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      if (!inputReady) {
        logger.warn(`[HhHybrid] Поле textarea[data-qa="text-input"] не появилось в чате.`);
        return false;
      }

      await input.focus().catch(() => undefined);
      await input.fill(coverLetter);
      await page.waitForTimeout(600);

      const sendBtn = chatFrame.locator('[data-qa="chatik-do-send-message"]').first();
      const sendVisible = await sendBtn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
      if (sendVisible) {
        await sendBtn.click().catch(() => undefined);
      } else {
        await input.press('Enter').catch(() => undefined);
      }
      await page.waitForTimeout(2000);

      let inputVal = await input.inputValue().catch(() => '');
      if (inputVal.length > 0) {
        const sendStillVisible = await sendBtn.isVisible().catch(() => false);
        if (sendStillVisible) {
          await sendBtn.click().catch(() => undefined);
        } else {
          await input.press('Enter').catch(() => undefined);
        }
        await page.waitForTimeout(2000);
        inputVal = await input.inputValue().catch(() => '');
      }

      if (inputVal.length > 0) {
        logger.warn('[HhHybrid] Поле ввода в чате не очистилось после отправки.');
        return false;
      }

      await addCoverBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined);
      return true;
    } catch (err) {
      logger.warn(`[HhHybrid] Ошибка во фрейме chatik: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async hasHardTestOrBlocker(page: Page): Promise<boolean> {
    return this.isHiddenResumeWarningBlocking(page);
  }

  private async scrapeEmployerQuestions(page: Page): Promise<EmployerQuestionItem[]> {
    if (typeof page.evaluate === 'function') {
      try {
        const evaluated = await page.evaluate(() => {
          const normalize = (val: string | null | undefined): string =>
            (val ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

          const items: Array<{
            id: string;
            questionText: string;
            fieldType: 'text' | 'textarea' | 'radio' | 'checkbox';
            options?: string[];
          }> = [];

          const containers = Array.from(
            document.querySelectorAll(
              '[data-qa="task-body"], [data-qa="vacancy-response-popup-questions"] [data-qa="task-question"], form [data-qa*="task"]'
            )
          );

          if (containers.length > 0) {
            containers.forEach((container, idx) => {
              const titleEl = container.querySelector(
                '[data-qa="task-question-title"], [data-qa="task-text"], .bloko-header-3, legend, label'
              );
              const questionText = normalize(titleEl?.textContent) || `Question ${idx + 1}`;

              const extractOpts = (els: Element[]) =>
                els
                  .map((r) => normalize((r.closest('label') ?? document.querySelector(`label[for="${r.id}"]`))?.textContent || r.getAttribute('value')))
                  .filter((opt): opt is string => opt.length > 0);

              const textarea = container.querySelector('textarea');
              if (textarea) {
                items.push({ id: textarea.getAttribute('name') || textarea.id || `task_${idx}`, questionText, fieldType: 'textarea' });
                return;
              }
              const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
              if (radios.length > 0) {
                items.push({ id: radios[0].getAttribute('name') || `task_${idx}`, questionText, fieldType: 'radio', options: extractOpts(radios) });
                return;
              }
              const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
              if (checkboxes.length > 0) {
                items.push({ id: checkboxes[0].getAttribute('name') || `task_${idx}`, questionText, fieldType: 'checkbox', options: extractOpts(checkboxes) });
                return;
              }
              const textInput = container.querySelector('input[type="text"], input:not([type])');
              if (textInput) {
                items.push({ id: textInput.getAttribute('name') || textInput.id || `task_${idx}`, questionText, fieldType: 'text' });
              }
            });
          }

          if (items.length === 0) {
            const directInputs = Array.from(
              document.querySelectorAll('textarea[name^="task_"], input[name^="task_"], [data-qa="test-task-input"]')
            );
            directInputs.forEach((inp, idx) => {
              const id = inp.getAttribute('name') || inp.id || `task_${idx}`;
              const tag = inp.tagName.toLowerCase();
              const type = inp.getAttribute('type') || 'text';
              const label = inp.closest('label') ?? (inp.id ? document.querySelector(`label[for="${inp.id}"]`) : null);
              const questionText = normalize(label?.textContent || inp.getAttribute('placeholder')) || `Question ${idx + 1}`;
              if (tag === 'textarea' || inp.getAttribute('data-qa') === 'test-task-input') {
                items.push({ id, questionText, fieldType: 'textarea' });
              } else if (type === 'radio' || type === 'checkbox') {
                items.push({ id, questionText, fieldType: type, options: [] });
              } else {
                items.push({ id, questionText, fieldType: 'text' });
              }
            });
          }
          return items;
        });
        if (Array.isArray(evaluated) && evaluated.length > 0) {
          return evaluated;
        }
      } catch {}
    }

    const fallbackItems: EmployerQuestionItem[] = [];
    const textareas = page.locator('textarea[name^="task_"], [data-qa="test-task-input"]');
    const taCount = await textareas.count().catch(() => 0);
    for (let i = 0; i < taCount; i++) {
      const el = typeof textareas.nth === 'function' ? textareas.nth(i) : textareas.first();
      const name = (await el.getAttribute('name').catch(() => null)) || `task_${i}`;
      fallbackItems.push({ id: name, questionText: 'Test question', fieldType: 'textarea' });
    }

    const radioLoc = page.locator('input[type="radio"][name^="task_"]');
    if ((await radioLoc.count().catch(() => 0)) > 0) {
      const el = typeof radioLoc.nth === 'function' ? radioLoc.nth(0) : radioLoc.first();
      const name = (await el.getAttribute('name').catch(() => null)) || 'task_radio';
      fallbackItems.push({ id: name, questionText: 'Radio question', fieldType: 'radio', options: [] });
    }

    const checkLoc = page.locator('input[type="checkbox"][name^="task_"]');
    if ((await checkLoc.count().catch(() => 0)) > 0) {
      const el = typeof checkLoc.nth === 'function' ? checkLoc.nth(0) : checkLoc.first();
      const name = (await el.getAttribute('name').catch(() => null)) || 'task_checkbox';
      fallbackItems.push({ id: name, questionText: 'Checkbox question', fieldType: 'checkbox', options: [] });
    }

    const textInputs = page.locator('input[type="text"][name^="task_"]');
    const textCount = await textInputs.count().catch(() => 0);
    for (let i = 0; i < textCount; i++) {
      const el = typeof textInputs.nth === 'function' ? textInputs.nth(i) : textInputs.first();
      const name = (await el.getAttribute('name').catch(() => null)) || `task_text_${i}`;
      fallbackItems.push({ id: name, questionText: 'Text question', fieldType: 'text' });
    }
    return fallbackItems;
  }

  private async fillEmployerQuestionAnswers(
    page: Page,
    questions: ReadonlyArray<EmployerQuestionItem>,
    answers: ReadonlyArray<EmployerQuestionAnswer>
  ): Promise<boolean> {
    if (answers.length === 0) {
      return false;
    }

    let filledCount = 0;
    for (const answer of answers) {
      const q = questions.find((item) => item.id === answer.id);
      const fieldType =
        q?.fieldType ??
        (answer.selectedOptions && answer.selectedOptions.length > 0 ? 'radio' : 'textarea');

      try {
        if ((fieldType === 'textarea' || fieldType === 'text') && answer.answerText) {
          const locator = page
            .locator(
              `textarea[name="${answer.id}"], input[name="${answer.id}"], [data-qa="test-task-input"]`
            )
            .first();
          const count = await locator.count().catch(() => 0);
          if (count > 0) {
            await locator.fill(answer.answerText);
            await page.waitForTimeout(300);
            filledCount++;
          }
        } else if (
          (fieldType === 'radio' || fieldType === 'checkbox') &&
          answer.selectedOptions &&
          answer.selectedOptions.length > 0
        ) {
          for (const optText of answer.selectedOptions) {
            const labelLocator = page.locator('label', { hasText: optText }).first();
            const count = await labelLocator.count().catch(() => 0);
            if (count > 0) {
              await labelLocator.click();
              await page.waitForTimeout(300);
              filledCount++;
            }
          }
        }
      } catch {
      }
    }

    return filledCount > 0;
  }

  private async submitQuestionsFormOrModal(page: Page): Promise<SafeResult<boolean>> {
    const modalRes = await this.submitModalIfPresent(page);
    if (modalRes.data) {
      return modalRes;
    }

    const submitSelectors = [
      '[data-qa="vacancy-response-submit-popup"]',
      '[data-qa="vacancy-response-letter-submit"]',
      'button[type="submit"]:has-text("Отправить")',
      'button:has-text("Отправить")',
      'button:has-text("Откликнуться")',
    ];

    for (const selector of submitSelectors) {
      const btn = page.locator(selector).first();
      const count = await btn.count().catch(() => 0);
      if (count > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click().catch(() => undefined);
        await page.waitForTimeout(1200);
        return { data: true, error: null };
      }
    }

    return { data: false, error: null };
  }
}
