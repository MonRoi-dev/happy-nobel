import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createLogger } from '../../utils/logger.ts';
import type { SafeResult } from '../config-store/index.ts';
import type {
  EmployerQuestionAnswer,
  EmployerQuestionItem,
  VacancyEvaluationInput,
  VacancyEvaluationResult,
} from '../llm/index.ts';
import { extractHhVacancyIdFromUrl } from './tg-channel-scraper.service.ts';

const logger = createLogger('ExternalFormApplier');

export interface ExternalApplicantProfile {
  readonly applicantName: string;
  readonly applicantEmail: string | null;
  readonly applicantPhone: string | null;
  readonly applicantTelegram: string | null;
  readonly resumeRawText: string;
  readonly resumePdfPath: string | null;
  readonly customPromptRules?: string | null;
}

export interface ExternalFormApplyInput {
  readonly targetUrl: string;
  readonly channelPostText: string;
  readonly positionTitle: string;
  readonly companyName: string;
  readonly applicantProfile: ExternalApplicantProfile;
  readonly minMatchScore: number;
  readonly evaluateVacancyFn: (
    input: VacancyEvaluationInput
  ) => Promise<SafeResult<VacancyEvaluationResult>>;
  readonly questionSolver?: (
    questions: ReadonlyArray<EmployerQuestionItem>
  ) => Promise<SafeResult<EmployerQuestionAnswer[]>>;
}

export type ExternalFormApplyStatus =
  | 'applied_external'
  | 'pending_external_captcha'
  | 'redirected_to_hh'
  | 'skipped_low_score'
  | 'missing_resume_pdf';

export interface ExternalFormApplyOutcome {
  readonly status: ExternalFormApplyStatus;
  readonly finalUrl: string;
  readonly hhVacancyId?: string;
  readonly hhVacancyUrl?: string;
  readonly matchScore?: number;
  readonly reasoning?: string;
  readonly coverLetter?: string;
  readonly screenshotPath?: string;
  readonly screenshotBuffer?: Buffer;
  readonly filledFieldsCount?: number;
}

export interface IExternalFormApplierService {
  applyToExternalForm(input: ExternalFormApplyInput): Promise<SafeResult<ExternalFormApplyOutcome>>;
}

export interface ExternalFormApplierOptions {
  readonly withPage?: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  readonly snapshotsDir?: string;
  readonly navigationTimeoutMs?: number;
}

const EXTERNAL_CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
] as const;

const NAME_FIELD_SELECTORS = [
  'input[name*="name" i]:not([type="hidden"])',
  'input[placeholder*="name" i]',
  'input[placeholder*="имя" i]',
  'input[placeholder*="фио" i]',
  'input[aria-label*="name" i]',
  'input[aria-label*="имя" i]',
] as const;

const EMAIL_FIELD_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="mail" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="почт" i]',
  'input[aria-label*="email" i]',
] as const;

const PHONE_FIELD_SELECTORS = [
  'input[type="tel"]',
  'input[name*="phone" i]',
  'input[name*="tel" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="телефон" i]',
  'input[aria-label*="phone" i]',
] as const;

const TELEGRAM_FIELD_SELECTORS = [
  'input[name*="telegram" i]',
  'input[name*="tg" i]',
  'input[placeholder*="telegram" i]',
  'input[placeholder*="телеграм" i]',
  'input[aria-label*="telegram" i]',
] as const;

const COMMENT_FIELD_SELECTORS = [
  'textarea[name*="comment" i]',
  'textarea[name*="letter" i]',
  'textarea[name*="message" i]',
  'textarea[placeholder*="comment" i]',
  'textarea[placeholder*="cover" i]',
  'textarea[placeholder*="сопроводительн" i]',
  'textarea[placeholder*="комментарий" i]',
  'textarea',
] as const;

const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("APPLY")',
  'button:has-text("Apply")',
  'button:has-text("Submit")',
  'button:has-text("Отправить")',
  'button:has-text("Откликнуться")',
] as const;

export class ExternalFormApplierService implements IExternalFormApplierService {
  private readonly customWithPage?: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  private readonly snapshotsDir: string;
  private readonly navigationTimeoutMs: number;

  constructor(options?: ExternalFormApplierOptions) {
    this.customWithPage = options?.withPage;
    this.snapshotsDir = options?.snapshotsDir ?? path.resolve(process.cwd(), 'logs', 'snapshots');
    this.navigationTimeoutMs = options?.navigationTimeoutMs ?? 30_000;
  }

  private async runWithPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.customWithPage) {
      return this.customWithPage(fn);
    }

    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      return await fn(page);
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  public async applyToExternalForm(
    input: ExternalFormApplyInput
  ): Promise<SafeResult<ExternalFormApplyOutcome>> {
    const directHhId = extractHhVacancyIdFromUrl(input.targetUrl);
    if (directHhId) {
      return {
        data: {
          status: 'redirected_to_hh',
          finalUrl: `https://hh.ru/vacancy/${directHhId}`,
          hhVacancyId: directHhId,
          hhVacancyUrl: `https://hh.ru/vacancy/${directHhId}`,
        },
        error: null,
      };
    }

    try {
      return await this.runWithPage(async (page) => {
        await page.goto(input.targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
        await page.waitForTimeout(1500);

        const currentUrl = page.url();
        const redirectedHhId = extractHhVacancyIdFromUrl(currentUrl);
        if (redirectedHhId) {
          logger.info(`Внешняя ссылка ${input.targetUrl} перенаправила на HH.ru (${redirectedHhId}).`);
          return {
            data: {
              status: 'redirected_to_hh',
              finalUrl: `https://hh.ru/vacancy/${redirectedHhId}`,
              hhVacancyId: redirectedHhId,
              hhVacancyUrl: `https://hh.ru/vacancy/${redirectedHhId}`,
            },
            error: null,
          };
        }

        const pageBodyText = await this.scrapePageDescriptionText(page);
        const combinedDescription = [
          input.channelPostText.trim(),
          pageBodyText.trim(),
        ]
          .filter((part) => part.length > 0)
          .join('\n\n---\n\n')
          .slice(0, 12_000);

        const evalRes = await input.evaluateVacancyFn({
          resumeRawText: input.applicantProfile.resumeRawText,
          vacancyTitle: input.positionTitle,
          companyName: input.companyName,
          vacancyDescription:
            combinedDescription.length >= 10
              ? combinedDescription
              : `${input.positionTitle} at ${input.companyName}`,
          customPromptRules: input.applicantProfile.customPromptRules,
          minMatchScore: input.minMatchScore,
        });

        if (evalRes.error || !evalRes.data) {
          return {
            data: null,
            error: evalRes.error ?? 'Failed to evaluate external vacancy with LLM',
          };
        }

        const { matchScore, reasoning, coverLetter } = evalRes.data;
        if (matchScore < input.minMatchScore) {
          return {
            data: {
              status: 'skipped_low_score',
              finalUrl: currentUrl,
              matchScore,
              reasoning,
              coverLetter: '',
            },
            error: null,
          };
        }

        let filledFieldsCount = 0;

        if (input.applicantProfile.applicantName) {
          if (await this.fillFirstMatchingField(page, NAME_FIELD_SELECTORS, input.applicantProfile.applicantName)) {
            filledFieldsCount += 1;
          }
        }

        if (input.applicantProfile.applicantEmail) {
          if (await this.fillFirstMatchingField(page, EMAIL_FIELD_SELECTORS, input.applicantProfile.applicantEmail)) {
            filledFieldsCount += 1;
          }
        }

        if (input.applicantProfile.applicantPhone) {
          if (await this.fillFirstMatchingField(page, PHONE_FIELD_SELECTORS, input.applicantProfile.applicantPhone)) {
            filledFieldsCount += 1;
          }
        }

        if (input.applicantProfile.applicantTelegram) {
          if (await this.fillFirstMatchingField(page, TELEGRAM_FIELD_SELECTORS, input.applicantProfile.applicantTelegram)) {
            filledFieldsCount += 1;
          }
        }

        const commentPayload =
          input.applicantProfile.applicantTelegram && !coverLetter.includes(input.applicantProfile.applicantTelegram)
            ? `${coverLetter}\n\nTelegram: ${input.applicantProfile.applicantTelegram}`
            : coverLetter;

        if (commentPayload.trim().length > 0) {
          if (await this.fillFirstMatchingField(page, COMMENT_FIELD_SELECTORS, commentPayload)) {
            filledFieldsCount += 1;
          }
        }

        await this.fillLabeledInputsInDom(page, {
          name: input.applicantProfile.applicantName,
          email: input.applicantProfile.applicantEmail,
          phone: input.applicantProfile.applicantPhone,
          telegram: input.applicantProfile.applicantTelegram,
          comment: commentPayload,
        });

        const fileLoc = page.locator('input[type="file"]');
        const fileCount = await fileLoc.count().catch(() => 0);
        if (fileCount > 0) {
          const pdfPath = input.applicantProfile.resumePdfPath;
          if (pdfPath && fs.existsSync(pdfPath)) {
            await fileLoc.first().setInputFiles(pdfPath);
            filledFieldsCount += 1;
            await page.waitForTimeout(400);
          } else {
            return {
              data: {
                status: 'missing_resume_pdf',
                finalUrl: currentUrl,
                matchScore,
                reasoning,
                coverLetter,
                filledFieldsCount,
              },
              error: null,
            };
          }
        }

        if (input.questionSolver) {
          const customQuestions = await this.scrapeUnfilledCustomQuestions(page);
          if (customQuestions.length > 0) {
            const answersRes = await input.questionSolver(customQuestions);
            if (answersRes.data && answersRes.data.length > 0) {
              for (const ans of answersRes.data) {
                if (ans.answerText) {
                  const loc = page
                    .locator(`input[name="${ans.id}"], textarea[name="${ans.id}"], #${ans.id}`)
                    .first();
                  if ((await loc.count().catch(() => 0)) > 0) {
                    await loc.fill(ans.answerText).catch(() => undefined);
                    filledFieldsCount += 1;
                  }
                }
              }
            }
          }
        }

        const hasCaptcha = await this.detectExternalCaptcha(page);
        if (hasCaptcha) {
          fs.mkdirSync(this.snapshotsDir, { recursive: true });
          const screenshotPath = path.join(this.snapshotsDir, `external-form-${Date.now()}.png`);
          const rawBuf = await page.screenshot({ path: screenshotPath }).catch(() => undefined);
          const screenshotBuffer = Buffer.isBuffer(rawBuf) ? rawBuf : undefined;

          return {
            data: {
              status: 'pending_external_captcha',
              finalUrl: currentUrl,
              matchScore,
              reasoning,
              coverLetter,
              screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : undefined,
              screenshotBuffer,
              filledFieldsCount,
            },
            error: null,
          };
        }

        await this.clickSubmitButton(page);
        await page.waitForTimeout(1500);

        return {
          data: {
            status: 'applied_external',
            finalUrl: currentUrl,
            matchScore,
            reasoning,
            coverLetter,
            filledFieldsCount,
          },
          error: null,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'External form application failed';
      return { data: null, error: msg };
    }
  }

  private async scrapePageDescriptionText(page: Page): Promise<string> {
    if (typeof page.evaluate !== 'function') {
      return '';
    }
    try {
      const text = await page.evaluate(() => {
        const root =
          document.querySelector('main, article, [role="main"]') ?? document.body;
        return (root as HTMLElement | null)?.innerText ?? '';
      });
      return typeof text === 'string' ? text.replace(/[ \t]+/g, ' ').trim() : '';
    } catch {
      return '';
    }
  }

  private async fillFirstMatchingField(
    page: Page,
    selectors: ReadonlyArray<string>,
    value: string
  ): Promise<boolean> {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          const first = loc.first();
          const visible =
            typeof first.isVisible === 'function'
              ? await first.isVisible().catch(() => true)
              : true;
          if (visible) {
            await first.fill(value);
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  private async fillLabeledInputsInDom(
    page: Page,
    values: {
      name: string;
      email: string | null;
      phone: string | null;
      telegram: string | null;
      comment: string;
    }
  ): Promise<void> {
    if (typeof page.evaluate !== 'function') {
      return;
    }
    try {
      await page.evaluate((payload) => {
        if (typeof document === 'undefined') return;
        const setVal = (el: HTMLInputElement | HTMLTextAreaElement, val: string | null) => {
          if (!val || el.value.trim().length > 0) return;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };

        const labels = Array.from(document.querySelectorAll('label'));
        for (const label of labels) {
          const text = (label.textContent ?? '').toLowerCase();
          const targetId = label.getAttribute('for');
          const input =
            (targetId ? document.getElementById(targetId) : null) ??
            label.querySelector('input, textarea') ??
            label.parentElement?.querySelector('input:not([type="file"]):not([type="checkbox"]), textarea');

          if (!input || !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
            continue;
          }

          if (/(your\s*name|full\s*name|имя|фио)/i.test(text)) {
            setVal(input, payload.name);
          } else if (/(e-?mail|почта)/i.test(text)) {
            setVal(input, payload.email);
          } else if (/(phone|телефон)/i.test(text)) {
            setVal(input, payload.phone);
          } else if (/(telegram|телеграм)/i.test(text)) {
            setVal(input, payload.telegram);
          } else if (/(comment|cover\s*letter|сопроводительн|комментарий)/i.test(text)) {
            setVal(input, payload.comment);
          }
        }
      }, values);
    } catch {}
  }

  private async scrapeUnfilledCustomQuestions(page: Page): Promise<EmployerQuestionItem[]> {
    if (typeof page.evaluate !== 'function') {
      return [];
    }
    try {
      const items = await page.evaluate(() => {
        const customQuestions: Array<{
          id: string;
          questionText: string;
          fieldType: 'text' | 'textarea';
        }> = [];
        if (typeof document === 'undefined') return customQuestions;
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[type="text"], textarea'
          )
        );
        inputs.forEach((inp, idx) => {
          if (inp.value.trim().length > 0) return;
          const id = inp.getAttribute('name') || inp.id;
          if (!id) return;
          const label =
            inp.closest('label')?.textContent ??
            (inp.id ? document.querySelector(`label[for="${inp.id}"]`)?.textContent : null) ??
            inp.getAttribute('placeholder');
          if (!label || label.trim().length < 2) return;
          customQuestions.push({
            id,
            questionText: label.trim(),
            fieldType: inp.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text',
          });
        });
        return customQuestions;
      });
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  private async detectExternalCaptcha(page: Page): Promise<boolean> {
    for (const sel of EXTERNAL_CAPTCHA_SELECTORS) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          const first = loc.first();
          const visible =
            typeof first.isVisible === 'function'
              ? await first.isVisible().catch(() => true)
              : true;
          if (visible) {
            return true;
          }
        }
      } catch {}
    }

    if (typeof page.evaluate === 'function') {
      const evalDetected = await page
        .evaluate(() => {
          const hasExternalCaptcha =
            typeof document !== 'undefined' &&
            Boolean(
              document.querySelector(
                'iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="hcaptcha"], .cf-turnstile'
              )
            );
          return hasExternalCaptcha;
        })
        .catch(() => false);
      if (evalDetected === true) {
        return true;
      }
    }

    return false;
  }

  private async clickSubmitButton(page: Page): Promise<boolean> {
    for (const sel of SUBMIT_BUTTON_SELECTORS) {
      try {
        const btn = page.locator(sel);
        const count = await btn.count().catch(() => 0);
        if (count > 0) {
          const first = btn.first();
          const visible =
            typeof first.isVisible === 'function'
              ? await first.isVisible().catch(() => true)
              : true;
          if (visible) {
            await first.click();
            return true;
          }
        }
      } catch {}
    }
    return false;
  }
}
