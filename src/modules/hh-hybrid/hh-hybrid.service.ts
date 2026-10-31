import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, userProfiles, type ApplicationRecord } from '../../db/schema.ts';
import { createLogger } from '../../utils/logger.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type { EmployerQuestionAnswer, EmployerQuestionItem } from '../llm/index.ts';
import { agentLogger } from '../logger/index.ts';
import type { IVacancyApplyFsm } from './hh-apply-fsm.ts';
import { hasActiveCaptchaSession } from './hh-captcha.detector.ts';
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

import {
  DefaultPlaywrightBrowserDriver,
  type PlaywrightBrowserDriver,
  type ScrapedVacancyDetailsResult,
} from './hh-playwright.driver.ts';

export {
  DefaultPlaywrightBrowserDriver,
  type PlaywrightBrowserDriver,
  type ScrapedVacancyDetailsResult,
};

export interface HhHybridOptions {
  readonly webBaseUrl?: string;
  readonly sessionDirName?: string;
  readonly customDriver?: PlaywrightBrowserDriver;
  readonly customApplyFsm?: IVacancyApplyFsm;
  readonly questionSolver?: (
    context: { vacancyId: string; vacancyUrl: string; vacancyTitle?: string; companyName?: string },
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
