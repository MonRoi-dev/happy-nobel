import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { SafeResult } from '../config-store/index.ts';
import { isBrowserClosedError } from './hh-hybrid.schemas.ts';

export const CAPTCHA_REQUIRED_ERROR = 'CAPTCHA_REQUIRED' as const;

export interface CaptchaChallengeSnapshot {
  readonly detected: boolean;
  readonly pageUrl: string;
  readonly screenshotPath?: string;
  readonly screenshotBuffer?: Buffer;
  readonly detectedSelector?: string;
}

export interface DetectCaptchaOptions {
  readonly captureSnapshot?: boolean;
  readonly snapshotsDir?: string;
}

export interface IHhCaptchaDetector {
  detectCaptchaOnPage(page: Page, options?: DetectCaptchaOptions): Promise<CaptchaChallengeSnapshot>;
  submitCaptchaTextOnPage(page: Page, captchaText: string): Promise<SafeResult<boolean>>;
  reloadCaptchaOnPage?(page: Page, options?: DetectCaptchaOptions): Promise<SafeResult<CaptchaChallengeSnapshot>>;
  getLastSnapshot?(): CaptchaChallengeSnapshot | null;
}

let activeCaptchaSession: {
  context: BrowserContext;
  page: Page;
  timer: ReturnType<typeof setTimeout>;
  onResolved?: () => Promise<void>;
} | null = null;

let globalLastCaptchaSnapshot: CaptchaChallengeSnapshot | null = null;

export function getGlobalLastCaptchaSnapshot(): CaptchaChallengeSnapshot | null {
  return globalLastCaptchaSnapshot;
}

export function setGlobalLastCaptchaSnapshot(snapshot: CaptchaChallengeSnapshot | null): void {
  globalLastCaptchaSnapshot = snapshot;
}

export async function closeActiveCaptchaSession(): Promise<void> {
  if (!activeCaptchaSession) {
    return;
  }
  const current = activeCaptchaSession;
  activeCaptchaSession = null;
  globalLastCaptchaSnapshot = null;
  clearTimeout(current.timer);
  await current.context.close().catch(() => undefined);
}

export function retainActiveCaptchaSession(
  context: BrowserContext,
  page: Page,
  onResolved?: () => Promise<void>
): void {
  if (activeCaptchaSession && activeCaptchaSession.context !== context) {
    clearTimeout(activeCaptchaSession.timer);
    void activeCaptchaSession.context.close().catch(() => undefined);
  }
  const timer = setTimeout(() => {
    void closeActiveCaptchaSession();
  }, 10 * 60 * 1000);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  activeCaptchaSession = { context, page, timer, onResolved };
}

export function hasActiveCaptchaSession(): boolean {
  if (!activeCaptchaSession) {
    return false;
  }
  try {
    if (
      typeof activeCaptchaSession.page.isClosed === 'function' &&
      activeCaptchaSession.page.isClosed()
    ) {
      activeCaptchaSession = null;
      return false;
    }
    return true;
  } catch {
    activeCaptchaSession = null;
    return false;
  }
}

export async function captureActiveCaptchaSessionSnapshot(): Promise<CaptchaChallengeSnapshot | null> {
  if (!hasActiveCaptchaSession() || !activeCaptchaSession) {
    return globalLastCaptchaSnapshot;
  }
  const detector = new HhCaptchaDetector();
  const snap = await detector.detectCaptchaOnPage(activeCaptchaSession.page, {
    captureSnapshot: true,
  });
  return snap.detected ? snap : globalLastCaptchaSnapshot;
}

export async function reloadActiveCaptchaSession(
  detector: IHhCaptchaDetector
): Promise<SafeResult<CaptchaChallengeSnapshot>> {
  if (!hasActiveCaptchaSession() || !activeCaptchaSession) {
    return { data: null, error: 'Активная сессия капчи не найдена' };
  }
  if (!detector.reloadCaptchaOnPage) {
    return { data: null, error: 'Метод обновления капчи не поддерживается детектором' };
  }
  try {
    return await detector.reloadCaptchaOnPage(activeCaptchaSession.page);
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function submitOnActiveCaptchaSession(
  captchaText: string,
  detector: IHhCaptchaDetector
): Promise<SafeResult<boolean>> {
  if (!hasActiveCaptchaSession() || !activeCaptchaSession) {
    return { data: null, error: 'Активная сессия капчи не найдена' };
  }
  try {
    const res = await detector.submitCaptchaTextOnPage(activeCaptchaSession.page, captchaText);
    if (res.data === true) {
      if (typeof activeCaptchaSession.page.waitForTimeout === 'function') {
        await activeCaptchaSession.page.waitForTimeout(1000);
      }
      if (activeCaptchaSession.onResolved) {
        await activeCaptchaSession.onResolved().catch(() => undefined);
      }
      await closeActiveCaptchaSession();
    }
    return res;
  } catch (err) {
    if (isBrowserClosedError(err)) {
      await closeActiveCaptchaSession();
    }
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyAndFinishActiveCaptchaSession(
  detector: IHhCaptchaDetector
): Promise<SafeResult<boolean>> {
  if (!hasActiveCaptchaSession() || !activeCaptchaSession) {
    return { data: null, error: 'Активная сессия капчи не найдена' };
  }
  try {
    const snap = await detector.detectCaptchaOnPage(activeCaptchaSession.page, {
      captureSnapshot: false,
    });
    if (snap.detected) {
      return {
        data: false,
        error: 'Модальное окно капчи всё ещё активно на странице',
      };
    }
    if (activeCaptchaSession.onResolved) {
      await activeCaptchaSession.onResolved().catch(() => undefined);
    }
    await closeActiveCaptchaSession();
    return { data: true, error: null };
  } catch (err) {
    await closeActiveCaptchaSession();
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const CAPTCHA_SELECTORS = [
  '[data-qa="account-captcha-picture"]',
  '[data-qa="account-captcha-input"]',
  'text="Пройдите капчу"',
  'input[placeholder*="Текст с картинки"]',
  '[data-qa*="captcha"]',
  'iframe[src*="captcha"]',
] as const;

export class HhCaptchaDetector implements IHhCaptchaDetector {
  private lastSnapshot: CaptchaChallengeSnapshot | null = null;

  public getLastSnapshot(): CaptchaChallengeSnapshot | null {
    return this.lastSnapshot ?? globalLastCaptchaSnapshot;
  }

  public async detectCaptchaOnPage(
    page: Page,
    options?: DetectCaptchaOptions
  ): Promise<CaptchaChallengeSnapshot> {
    for (const selector of CAPTCHA_SELECTORS) {
      const locator = page.locator(selector);
      if (!locator || typeof locator.count !== 'function') {
        continue;
      }

      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        const first = typeof locator.first === 'function' ? locator.first() : locator;
        const visible =
          typeof first.isVisible === 'function'
            ? await first.isVisible().catch(() => true)
            : true;

        if (visible) {
          if (typeof page.evaluate === 'function') {
            const isGenuine = await page
              .evaluate(() => {
                if (location.pathname.includes('captcha')) return true;
                const bodyText = document.body?.innerText ?? '';
                if (bodyText.includes('Пройдите капчу') || bodyText.includes('Текст с картинки')) {
                  return true;
                }
                const strictEls = document.querySelectorAll<HTMLElement>(
                  '[data-qa="account-captcha-picture"], [data-qa="account-captcha-input"], input[placeholder*="Текст с картинки"]'
                );
                for (const el of Array.from(strictEls)) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width >= 30 && rect.height >= 15) return true;
                }
                return false;
              })
              .catch(() => true);
            if (!isGenuine) {
              continue;
            }
          }
          const pageUrl = typeof page.url === 'function' ? page.url() : 'https://hh.ru';
          let screenshotPath: string | undefined;
          let screenshotBuffer: Buffer | undefined;

          if (options?.captureSnapshot !== false && typeof page.screenshot === 'function') {
            try {
              if (typeof page.evaluate === 'function') {
                await page
                  .evaluate(async () => {
                    const deadline = Date.now() + 2500;
                    while (Date.now() < deadline) {
                      const img = document.querySelector<HTMLImageElement>(
                        'img[data-qa="account-captcha-picture"], [data-qa*="captcha"] img, img[src*="captcha"]'
                      );
                      if (img && img.complete && img.naturalWidth > 0) {
                        break;
                      }
                      await new Promise((r) => setTimeout(r, 150));
                    }
                  })
                  .catch(() => undefined);
              }
              if (typeof page.waitForTimeout === 'function') {
                await page.waitForTimeout(300);
              }
              const snapshotsDir =
                options?.snapshotsDir ?? path.resolve(process.cwd(), 'logs', 'snapshots');
              fs.mkdirSync(snapshotsDir, { recursive: true });
              screenshotPath = path.join(snapshotsDir, `captcha-${Date.now()}.png`);
              const buf = await page.screenshot({ path: screenshotPath });
              if (Buffer.isBuffer(buf)) {
                screenshotBuffer = buf;
                if (!fs.existsSync(screenshotPath)) {
                  fs.writeFileSync(screenshotPath, buf);
                }
              } else if (fs.existsSync(screenshotPath)) {
                screenshotBuffer = fs.readFileSync(screenshotPath);
              }
            } catch {
            }
          }

          const snapshot: CaptchaChallengeSnapshot = {
            detected: true,
            pageUrl,
            screenshotPath,
            screenshotBuffer,
            detectedSelector: selector,
          };
          this.lastSnapshot = snapshot;
          globalLastCaptchaSnapshot = snapshot;
          return snapshot;
        }
      }
    }

    const pageUrl = typeof page.url === 'function' ? page.url() : 'https://hh.ru';
    return { detected: false, pageUrl };
  }

  public async submitCaptchaTextOnPage(
    page: Page,
    captchaText: string
  ): Promise<SafeResult<boolean>> {
    const trimmedText = captchaText.trim();
    if (trimmedText.length === 0) {
      return { data: null, error: 'Текст капчи не может быть пустым' };
    }

    const inputLocator = page
      .locator(
        'input[data-qa="account-captcha-input"], input[placeholder*="Текст с картинки"], input[data-qa*="captcha"], input[name*="captcha"]'
      )
      .first();

    if (!inputLocator || typeof inputLocator.count !== 'function') {
      return {
        data: null,
        error: 'Поле ввода капчи ("Текст с картинки") не найдено на странице',
      };
    }

    if (typeof inputLocator.waitFor === 'function') {
      await inputLocator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
    }

    if ((await inputLocator.count().catch(() => 0)) === 0) {
      return {
        data: null,
        error: 'Поле ввода капчи ("Текст с картинки") не найдено на странице',
      };
    }

    if (typeof inputLocator.click === 'function') {
      await inputLocator.click().catch(() => undefined);
    }
    if (typeof inputLocator.fill === 'function') {
      await inputLocator.fill('').catch(() => undefined);
    }
    if (typeof inputLocator.pressSequentially === 'function') {
      await inputLocator.pressSequentially(trimmedText, { delay: 35 }).catch(() => undefined);
    } else if (typeof inputLocator.fill === 'function') {
      await inputLocator.fill(trimmedText).catch(() => undefined);
    }

    if (typeof inputLocator.evaluate === 'function') {
      await inputLocator.evaluate((el: HTMLInputElement, val: string) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, trimmedText).catch(() => undefined);
    }

    const modalContainer = page
      .locator(
        '[role="dialog"]:has([data-qa*="captcha"]), .bloko-modal:has([data-qa*="captcha"]), form:has(input[data-qa="account-captcha-input"]), div:has(> [data-qa="account-captcha-picture"])'
      )
      .first();

    const hasContainer =
      modalContainer && typeof modalContainer.count === 'function'
        ? (await modalContainer.count().catch(() => 0)) > 0
        : false;

    const scopedSubmitBtn =
      hasContainer && typeof modalContainer.locator === 'function'
        ? modalContainer
            .locator('button:has-text("Отправить"), [data-qa*="submit"], button[type="submit"]')
            .first()
        : null;

    let submitClicked = false;
    if (
      scopedSubmitBtn &&
      typeof scopedSubmitBtn.count === 'function' &&
      (await scopedSubmitBtn.count().catch(() => 0)) > 0
    ) {
      await scopedSubmitBtn.click({ timeout: 3000 }).catch(() => undefined);
      submitClicked = true;
    } else {
      const primarySubmitBtn = page
        .locator(
          '[data-qa="account-captcha-submit"], [data-qa*="captcha-submit"], [data-qa="modal-footer"] button:has-text("Отправить"), button:has-text("Отправить")'
        )
        .first();

      const hasPrimaryBtn =
        primarySubmitBtn &&
        typeof primarySubmitBtn.count === 'function' &&
        (await primarySubmitBtn.count().catch(() => 0)) > 0;

      if (hasPrimaryBtn) {
        await primarySubmitBtn.click({ timeout: 3000 }).catch(() => undefined);
        submitClicked = true;
      } else {
        const fallbackSubmitBtn = page.locator('button[type="submit"]').first();
        if (
          fallbackSubmitBtn &&
          typeof fallbackSubmitBtn.count === 'function' &&
          (await fallbackSubmitBtn.count().catch(() => 0)) > 0
        ) {
          await fallbackSubmitBtn.click({ timeout: 3000 }).catch(() => undefined);
          submitClicked = true;
        }
      }
    }

    if (!submitClicked && typeof inputLocator.press === 'function') {
      await inputLocator.press('Enter').catch(() => undefined);
    }

    const startTime = Date.now();
    let isResolved = false;

    while (Date.now() - startTime < 6000) {
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(400);
      }
      const checkSnap = await this.detectCaptchaOnPage(page, { captureSnapshot: false });
      if (!checkSnap.detected) {
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(400);
        }
        const verifySnap = await this.detectCaptchaOnPage(page, { captureSnapshot: false });
        if (!verifySnap.detected) {
          isResolved = true;
          break;
        }
      }
    }

    if (!isResolved) {
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(500);
      }
      const refreshedSnap = await this.detectCaptchaOnPage(page, { captureSnapshot: true });
      if (!refreshedSnap.detected) {
        isResolved = true;
      } else {
        this.lastSnapshot = refreshedSnap;
        globalLastCaptchaSnapshot = refreshedSnap;

        let latestError: string | null = null;
        if (typeof page.evaluate === 'function') {
          latestError = await page
            .evaluate(() => {
              const modal = document.querySelector('[role="dialog"], .bloko-modal') ?? document;
              const errEl = modal.querySelector(
                '[data-qa*="captcha-error"], .bloko-form-error'
              );
              if (errEl && errEl instanceof HTMLElement && errEl.innerText.trim().length > 0) {
                return errEl.innerText.trim();
              }
              return null;
            })
            .catch(() => null);
        }

        return {
          data: false,
          error: latestError ?? 'Капча все еще отображается (возможно, неверный текст)',
        };
      }
    }

    this.lastSnapshot = null;
    globalLastCaptchaSnapshot = null;
    return { data: true, error: null };
  }

  public async reloadCaptchaOnPage(
    page: Page,
    options?: DetectCaptchaOptions
  ): Promise<SafeResult<CaptchaChallengeSnapshot>> {
    const reloadBtn = page
      .locator(
        'button[data-qa="account-captcha-refresh"], button[data-qa="account-captcha-reload"], button[data-qa*="captcha-refresh"], button[data-qa*="captcha-reload"], button[data-qa*="refresh"], button[data-qa*="reload"], [data-qa*="reload-captcha"]'
      )
      .first();

    let clicked = false;
    if (
      reloadBtn &&
      typeof reloadBtn.count === 'function' &&
      (await reloadBtn.count().catch(() => 0)) > 0
    ) {
      await reloadBtn.click({ timeout: 3000 }).catch(() => undefined);
      clicked = true;
    } else if (typeof page.evaluate === 'function') {
      clicked = await page
        .evaluate(() => {
          const img = document.querySelector<HTMLImageElement>(
            'img[data-qa="account-captcha-picture"], [data-qa*="captcha"] img, img[src*="captcha"]'
          );
          if (img) {
            const container = img.closest('[role="dialog"], .bloko-modal, div') ?? img.parentElement;
            if (container) {
              const enBtn = Array.from(container.querySelectorAll('button')).find((b) =>
                b.textContent?.includes('English') || b.textContent?.includes('Русский')
              );
              if (enBtn && enBtn.parentElement) {
                const siblingBtn = Array.from(enBtn.parentElement.querySelectorAll('button')).find(
                  (b) => b !== enBtn
                );
                if (siblingBtn) {
                  siblingBtn.click();
                  return true;
                }
              }
              const svgBtns = Array.from(container.querySelectorAll('button')).filter(
                (b) => b.querySelector('svg') && !b.textContent?.includes('Отправить')
              );
              if (svgBtns.length > 0) {
                svgBtns[0].click();
                return true;
              }
            }
          }
          const ariaBtn = document.querySelector<HTMLButtonElement>(
            'button[aria-label*="обновить" i], button[title*="обновить" i], button[aria-label*="другой" i]'
          );
          if (ariaBtn) {
            ariaBtn.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
    }

    if (!clicked) {
      return { data: null, error: 'Кнопка обновления капчи не найдена на странице' };
    }

    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(800);
    }

    if (typeof page.evaluate === 'function') {
      await page
        .evaluate(async () => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const img = document.querySelector<HTMLImageElement>(
              'img[data-qa="account-captcha-picture"], [data-qa*="captcha"] img, img[src*="captcha"]'
            );
            if (img && img.complete && img.naturalWidth > 0) {
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
        })
        .catch(() => undefined);
    }

    const snap = await this.detectCaptchaOnPage(page, {
      captureSnapshot: true,
      snapshotsDir: options?.snapshotsDir,
    });

    if (!snap.detected) {
      return { data: null, error: 'Капча исчезла после обновления' };
    }

    this.lastSnapshot = snap;
    globalLastCaptchaSnapshot = snap;
    return { data: snap, error: null };
  }
}
