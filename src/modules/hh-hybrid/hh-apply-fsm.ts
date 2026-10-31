import type { Page, Frame } from 'playwright';
import type { SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';
import { createLogger } from '../../utils/logger.ts';
import {
  attachCoverLetterViaChatOnPage,
  checkEmployerQuestionsRequiredOnPage,
  checkForeignCountryWarningOnPage,
  fillEmployerQuestionAnswersOnPage,
  hasFormValidationErrorsOnPage,
  scrapeEmployerQuestionsOnPage,
  submitQuestionsFormOrModalOnPage,
  waitForChatAndSendLetterOnPage,
} from './hh-apply-questions.helper.ts';
import {
  CAPTCHA_REQUIRED_ERROR,
  HhCaptchaDetector,
  type CaptchaChallengeSnapshot,
  type IHhCaptchaDetector,
} from './hh-captcha.detector.ts';

const logger = createLogger('HhHybrid');

export interface HhApplyFormContext {
  readonly vacancyId: string;
  readonly vacancyUrl: string;
  readonly vacancyTitle?: string;
  readonly companyName?: string;
}

export type EmployerQuestionSolver = (
  questions: ReadonlyArray<EmployerQuestionItem>,
  context?: HhApplyFormContext
) => Promise<SafeResult<EmployerQuestionAnswer[]>>;

export const FOREIGN_VACANCY_ERROR = 'FOREIGN_VACANCY' as const;

export interface ApplyWorkflowInput {
  readonly page: Page;
  readonly vacancyId: string;
  readonly vacancyUrl: string;
  readonly vacancyTitle?: string;
  readonly companyName?: string;
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

      const solvedRes = await this.solveEmployerQuestions(input, scrapedQuestions);
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
    return checkForeignCountryWarningOnPage(page);
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
    return checkEmployerQuestionsRequiredOnPage(page, (p) => this.isHiddenResumeWarningBlocking(p));
  }

  private async hasFormValidationErrors(page: Page): Promise<boolean> {
    return hasFormValidationErrorsOnPage(page);
  }

  private async attachCoverLetterViaChat(
    page: Page,
    vacancyId: string,
    coverLetter: string,
    webBaseUrl: string,
    requireUnattachedAction = false
  ): Promise<boolean> {
    return attachCoverLetterViaChatOnPage(page, vacancyId, coverLetter, webBaseUrl, requireUnattachedAction);
  }

  private async waitForChatAndSendLetter(
    page: Page,
    coverLetter: string,
    requireUnattachedAction = false
  ): Promise<boolean> {
    return waitForChatAndSendLetterOnPage(page, coverLetter, requireUnattachedAction);
  }

  private async hasHardTestOrBlocker(page: Page): Promise<boolean> {
    return this.isHiddenResumeWarningBlocking(page);
  }

  private async scrapeEmployerQuestions(page: Page): Promise<EmployerQuestionItem[]> {
    return scrapeEmployerQuestionsOnPage(page);
  }

  private async fillEmployerQuestionAnswers(
    page: Page,
    questions: ReadonlyArray<EmployerQuestionItem>,
    answers: ReadonlyArray<EmployerQuestionAnswer>
  ): Promise<boolean> {
    return fillEmployerQuestionAnswersOnPage(page, questions, answers);
  }

  private async submitQuestionsFormOrModal(page: Page): Promise<SafeResult<boolean>> {
    return submitQuestionsFormOrModalOnPage(page, (p) => this.submitModalIfPresent(p));
  }

  private async solveEmployerQuestions(
    input: ApplyWorkflowInput,
    questions: ReadonlyArray<EmployerQuestionItem>
  ): Promise<SafeResult<EmployerQuestionAnswer[]>> {
    if (!input.questionSolver) {
      return { data: null, error: 'QUESTIONS_REQUIRED' };
    }
    const context: HhApplyFormContext = {
      vacancyId: input.vacancyId,
      vacancyUrl: input.vacancyUrl,
      vacancyTitle: input.vacancyTitle,
      companyName: input.companyName,
    };
    return input.questionSolver(questions, context);
  }
}
