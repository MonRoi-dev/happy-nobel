import { chromium, type BrowserContext } from 'playwright';
import type { SafeResult } from '../config-store/index.ts';
import type { ISqliteQueueService } from '../queue/index.ts';
import { buildCaptchaAlertCaption } from '../telegram/telegram-captcha.handler.ts';
import {
  captureActiveCaptchaSessionSnapshot,
  closeActiveCaptchaSession,
  getGlobalLastCaptchaSnapshot,
  hasActiveCaptchaSession,
  HhCaptchaDetector,
  reloadActiveCaptchaSession,
  submitOnActiveCaptchaSession,
  verifyAndFinishActiveCaptchaSession,
  type CaptchaChallengeSnapshot,
  type IHhCaptchaDetector,
} from './hh-captcha.detector.ts';
import type { IHhHybridService } from './hh-hybrid.service.ts';

export interface IHhBrowserCaptchaService {
  getActiveChallenge(): CaptchaChallengeSnapshot | null;
  setActiveChallenge(snapshot: CaptchaChallengeSnapshot | null): void;
  isAwaitingCaptcha(): boolean;
  handleCaptchaDetected(
    snapshot: CaptchaChallengeSnapshot,
    activeTaskId?: number
  ): Promise<SafeResult<boolean>>;
  submitCaptchaText(captchaText: string): Promise<SafeResult<boolean>>;
  verifyAndResumeCaptcha(): Promise<SafeResult<boolean>>;
  reloadCaptcha(): Promise<SafeResult<CaptchaChallengeSnapshot>>;
}

export interface HhBrowserCaptchaServiceDeps {
  readonly hhHybrid?: IHhHybridService;
  readonly queueService?: ISqliteQueueService;
  readonly detector?: IHhCaptchaDetector;
  readonly onNotifyCaptcha?: (snapshot: CaptchaChallengeSnapshot) => Promise<SafeResult<boolean>>;
  readonly onCaptchaResolved?: () => Promise<void> | void;
  readonly captchaSolverRunner?: (
    captchaText: string,
    pageUrl: string
  ) => Promise<SafeResult<boolean>>;
  readonly captchaVerifierRunner?: (pageUrl: string) => Promise<SafeResult<boolean>>;
  readonly captchaReloaderRunner?: (pageUrl: string) => Promise<SafeResult<CaptchaChallengeSnapshot>>;
}

export class HhBrowserCaptchaService implements IHhBrowserCaptchaService {
  private activeChallenge: CaptchaChallengeSnapshot | null = null;
  private readonly hhHybrid?: IHhHybridService;
  private readonly queueService?: ISqliteQueueService;
  private readonly detector: IHhCaptchaDetector;
  private readonly onNotifyCaptcha?: (snapshot: CaptchaChallengeSnapshot) => Promise<SafeResult<boolean>>;
  private readonly onCaptchaResolved?: () => Promise<void> | void;
  private readonly captchaSolverRunner?: (
    captchaText: string,
    pageUrl: string
  ) => Promise<SafeResult<boolean>>;
  private readonly captchaVerifierRunner?: (pageUrl: string) => Promise<SafeResult<boolean>>;
  private readonly captchaReloaderRunner?: (pageUrl: string) => Promise<SafeResult<CaptchaChallengeSnapshot>>;

  constructor(deps?: HhBrowserCaptchaServiceDeps) {
    this.hhHybrid = deps?.hhHybrid;
    this.queueService = deps?.queueService;
    this.detector = deps?.detector ?? new HhCaptchaDetector();
    this.onNotifyCaptcha = deps?.onNotifyCaptcha;
    this.onCaptchaResolved = deps?.onCaptchaResolved;
    this.captchaSolverRunner = deps?.captchaSolverRunner;
    this.captchaVerifierRunner = deps?.captchaVerifierRunner;
    this.captchaReloaderRunner = deps?.captchaReloaderRunner;
  }

  public getActiveChallenge(): CaptchaChallengeSnapshot | null {
    return this.activeChallenge;
  }

  public setActiveChallenge(snapshot: CaptchaChallengeSnapshot | null): void {
    this.activeChallenge = snapshot;
  }

  public isAwaitingCaptcha(): boolean {
    return this.activeChallenge !== null && this.activeChallenge.detected === true;
  }

  public async handleCaptchaDetected(
    snapshot: CaptchaChallengeSnapshot,
    activeTaskId?: number
  ): Promise<SafeResult<boolean>> {
    let freshSnap: CaptchaChallengeSnapshot | null = null;
    if (snapshot.screenshotBuffer) {
      freshSnap = snapshot;
    } else if (hasActiveCaptchaSession()) {
      freshSnap = await captureActiveCaptchaSessionSnapshot();
    }
    if (!freshSnap?.screenshotBuffer) {
      freshSnap = this.detector.getLastSnapshot?.() ?? getGlobalLastCaptchaSnapshot();
    }
    const enrichedSnapshot: CaptchaChallengeSnapshot = {
      ...snapshot,
      ...(freshSnap?.screenshotBuffer || snapshot.screenshotBuffer
        ? { screenshotBuffer: freshSnap?.screenshotBuffer ?? snapshot.screenshotBuffer }
        : {}),
      ...(freshSnap?.screenshotPath || snapshot.screenshotPath
        ? { screenshotPath: freshSnap?.screenshotPath ?? snapshot.screenshotPath }
        : {}),
    };

    this.activeChallenge = enrichedSnapshot;

    if (activeTaskId !== undefined && this.queueService) {
      this.queueService.pauseForCaptcha(activeTaskId, 'CAPTCHA_REQUIRED');
    }

    let notifiedViaDirectCallback = false;
    if (this.onNotifyCaptcha) {
      try {
        const notifyRes = await this.onNotifyCaptcha(enrichedSnapshot);
        if (!notifyRes.error) {
          notifiedViaDirectCallback = true;
        }
      } catch {
        notifiedViaDirectCallback = false;
      }
    }

    if (!notifiedViaDirectCallback && this.queueService) {
      this.queueService.enqueue({
        taskType: 'SEND_TG_MESSAGE',
        priority: 10,
        payload: {
          kind: 'CAPTCHA_ALERT',
          pageUrl: enrichedSnapshot.pageUrl,
          screenshotPath: enrichedSnapshot.screenshotPath,
          text: buildCaptchaAlertCaption(enrichedSnapshot.pageUrl),
          parse_mode: 'HTML',
        },
      });
    }

    return { data: true, error: null };
  }

  public async reloadCaptcha(): Promise<SafeResult<CaptchaChallengeSnapshot>> {
    if (!this.activeChallenge) {
      return { data: null, error: 'Активное требование капчи не найдено' };
    }

    let res: SafeResult<CaptchaChallengeSnapshot>;
    if (this.captchaReloaderRunner) {
      res = await this.captchaReloaderRunner(this.activeChallenge.pageUrl);
    } else if (hasActiveCaptchaSession()) {
      res = await reloadActiveCaptchaSession(this.detector);
    } else {
      return { data: null, error: 'Активная сессия капчи не найдена для обновления' };
    }

    if (res.data) {
      this.activeChallenge = res.data;
      return { data: res.data, error: null };
    }

    return { data: null, error: res.error ?? 'Не удалось обновить капчу' };
  }

  public async submitCaptchaText(captchaText: string): Promise<SafeResult<boolean>> {
    if (!this.activeChallenge) {
      return { data: null, error: 'Активное требование капчи не найдено' };
    }

    const trimmed = captchaText.trim();
    if (trimmed.length === 0) {
      return { data: null, error: 'Текст капчи не может быть пустым' };
    }

    const pageUrl = this.activeChallenge.pageUrl;
    let res: SafeResult<boolean>;

    if (this.captchaSolverRunner) {
      res = await this.captchaSolverRunner(trimmed, pageUrl);
    } else if (hasActiveCaptchaSession()) {
      res = await submitOnActiveCaptchaSession(trimmed, this.detector);
      if (res.data === false) {
        const refreshed = this.detector.getLastSnapshot?.() ?? getGlobalLastCaptchaSnapshot();
        if (refreshed && !refreshed.detected) {
          res = { data: true, error: null };
        } else if (refreshed?.screenshotBuffer) {
          this.activeChallenge = {
            ...this.activeChallenge,
            screenshotBuffer: refreshed.screenshotBuffer,
            screenshotPath: refreshed.screenshotPath,
          };
        }
      }
    } else if (this.hhHybrid && typeof this.hhHybrid.runWithSession === 'function') {
      res = await this.hhHybrid.runWithSession(async (sessionDir) => {
        let context: BrowserContext | null = null;
        try {
          context = await chromium.launchPersistentContext(sessionDir, { headless: true });
          const page = await context.newPage();
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
          const submitRes = await this.detector.submitCaptchaTextOnPage(page, trimmed);
          return submitRes;
        } catch (err) {
          return { data: null, error: err instanceof Error ? err.message : String(err) };
        } finally {
          if (context) {
            await context.close().catch(() => undefined);
          }
        }
      });
    } else {
      res = { data: true, error: null };
    }

    if (res.data === true) {
      this.activeChallenge = null;
      this.queueService?.resumePausedCaptchaTasks();
      await this.onCaptchaResolved?.();
      return { data: true, error: null };
    }

    return { data: false, error: res.error ?? 'Капча не пройдена' };
  }

  public async verifyAndResumeCaptcha(): Promise<SafeResult<boolean>> {
    if (!this.activeChallenge) {
      return { data: null, error: 'Активное требование капчи не найдено' };
    }

    const pageUrl = this.activeChallenge.pageUrl;
    let res: SafeResult<boolean>;

    if (this.captchaVerifierRunner) {
      res = await this.captchaVerifierRunner(pageUrl);
    } else if (hasActiveCaptchaSession()) {
      res = await verifyAndFinishActiveCaptchaSession(this.detector);
    } else if (this.hhHybrid && typeof this.hhHybrid.runWithSession === 'function') {
      res = await this.hhHybrid.runWithSession(async (sessionDir) => {
        await closeActiveCaptchaSession();
        let context: BrowserContext | null = null;
        try {
          context = await chromium.launchPersistentContext(sessionDir, { headless: true });
          const page = await context.newPage();
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
          const snap = await this.detector.detectCaptchaOnPage(page, { captureSnapshot: false });
          if (snap.detected) {
            return {
              data: false,
              error: 'Модальное окно капчи всё ещё активно на странице',
            };
          }
          return { data: true, error: null };
        } catch (err) {
          return { data: null, error: err instanceof Error ? err.message : String(err) };
        } finally {
          if (context) {
            await context.close().catch(() => undefined);
          }
        }
      });
    } else {
      res = { data: true, error: null };
    }

    if (!res.data) {
      return {
        data: false,
        error: res.error ?? 'Модальное окно капчи всё ещё активно на странице',
      };
    }

    this.activeChallenge = null;
    this.queueService?.resumePausedCaptchaTasks();
    await this.onCaptchaResolved?.();
    return { data: true, error: null };
  }
}
