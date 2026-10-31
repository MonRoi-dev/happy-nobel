import { createHash, randomInt } from 'node:crypto';
import { Cron } from 'croner';
import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index.ts';
import {
  applicationRecords, searchFilters, userProfiles,
  type ApplicationRecord, type SearchFilter, type UserProfile,
} from '../../db/schema.ts';
import { calculateJitterDelayMs } from '../../utils/jitter.util.ts';
import { CircuitBreaker } from '../../utils/circuit-breaker.util.ts';
import { createLogger } from '../../utils/logger.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type {
  HhVacancyShortItem, IHhBrowserCaptchaService,
  IHhHybridService, IHhMessagingService,
} from '../hh-hybrid/index.ts';
import type { ILlmService } from '../llm/index.ts';
import type { ISqliteQueueService } from '../queue/index.ts';
import { syncUnreadMessagesCore, type ITelegramBotService } from '../telegram/index.ts';
import {
  countTodayAppliedRecords,
  filterUnappliedVacancies,
  formatAutoAppliedMessage,
  formatCircuitBreakerOpenMessage,
  formatDailyLimitReachedMessage,
  formatEmployerQuestionsEscalationText,
  formatLlmRestoredMessage,
  formatLlmUnavailableMessage,
  formatStatusLabel,
  buildEmployerUpdateNotification,
  getLocalDayKey,
  notifyPendingEmployerUpdates,
} from './scheduler-notifications.helper.ts';
import type {
  AutoApplyCycleSummary,
  ISchedulerService,
  SchedulerOptions,
  SingleApplicationResult,
  SyncNotificationsSummary,
} from './scheduler.types.ts';

const logger = createLogger('Scheduler');

export { formatStatusLabel, buildEmployerUpdateNotification };
export type {
  AutoApplyCycleSummary,
  ISchedulerService,
  SchedulerOptions,
  SingleApplicationResult,
  SyncNotificationsSummary,
};

const DEFAULT_MIN_DELAY_MS = 120_000;
const DEFAULT_MAX_DELAY_MS = 300_000;
const MAX_HARD_DAILY_LIMIT = 100;

const ANONYMOUS_COMPANY_NAMES = new Set(['', 'unknown', 'unknown company', 'работодатель не указан']);

export function isAnonymousCompany(name: string): boolean {
  return ANONYMOUS_COMPANY_NAMES.has(name.trim().toLowerCase());
}

export function computeRandomDelayMs(
  minDelayMs = DEFAULT_MIN_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS
): number {
  if (minDelayMs === DEFAULT_MIN_DELAY_MS && maxDelayMs === DEFAULT_MAX_DELAY_MS) {
    return calculateJitterDelayMs();
  }
  if (maxDelayMs <= minDelayMs) {
    return Math.max(0, minDelayMs);
  }
  return randomInt(minDelayMs, maxDelayMs + 1);
}

export class SchedulerService implements ISchedulerService {
  private readonly configStore: IConfigStore;
  private readonly db: AppDatabase;
  private readonly hhHybrid: IHhHybridService;
  private readonly llm: ILlmService;
  private readonly telegramBot: ITelegramBotService;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly autoApplyCronPattern: string;
  private readonly syncNegotiationsCronPattern: string;
  private readonly autoBumpCronPattern: string;
  private readonly manualApprovalDelayMs: number;
  private readonly maxPendingApprovals: number;
  private readonly hhMessaging?: IHhMessagingService;
  private readonly syncUnreadMessagesCronPattern: string;
  private readonly captchaService?: IHhBrowserCaptchaService;
  private readonly queueService?: ISqliteQueueService;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly hhCircuitBreaker: CircuitBreaker;
  private readonly evaluationCache = new Map<string, { matchScore: number; reasoning: string; coverLetter?: string }>();

  private autoApplyJob: Cron | null = null;
  private syncNegotiationsJob: Cron | null = null;
  private autoBumpResumeJob: Cron | null = null;
  private syncUnreadMessagesJob: Cron | null = null;
  private llmHealthJob: Cron | null = null;
  private dailyDigestJob: Cron | null = null;
  private isCycleRunning = false;
  private stopRequested = false;
  private isLlmUnavailableNotified = false;
  private lastLimitNotifiedDateKey: string | null = null;
  private abortSleepResolver: (() => void) | null = null;

  constructor(
    configStore: IConfigStore,
    db: AppDatabase,
    hhHybrid: IHhHybridService,
    llm: ILlmService,
    telegramBot: ITelegramBotService,
    options?: SchedulerOptions
  ) {
    this.configStore = configStore;
    this.db = db;
    this.hhHybrid = hhHybrid;
    this.llm = llm;
    this.telegramBot = telegramBot;
    this.minDelayMs = options?.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.autoApplyCronPattern = options?.autoApplyCronPattern ?? '*/10 * * * *';
    this.syncNegotiationsCronPattern = options?.syncNegotiationsCronPattern ?? '*/15 * * * *';
    this.autoBumpCronPattern = options?.autoBumpCronPattern ?? '*/30 * * * *';
    this.manualApprovalDelayMs = options?.manualApprovalDelayMs ?? 5000;
    this.maxPendingApprovals = options?.maxPendingApprovals ?? 10;
    this.hhMessaging = options?.hhMessaging;
    this.syncUnreadMessagesCronPattern = options?.syncUnreadMessagesCronPattern ?? '*/10 * * * *';
    this.captchaService = options?.captchaService;
    this.queueService = options?.queueService;
    this.sleepFn =
      options?.customSleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.hhCircuitBreaker =
      options?.hhCircuitBreaker ??
      new CircuitBreaker({
        failureThreshold: options?.circuitBreakerThreshold ?? 3,
        cooldownMs: options?.circuitBreakerCooldownMs ?? 15 * 60 * 1000,
      });
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          this.abortSleepResolver = null;
          resolve();
        }
      };
      this.abortSleepResolver = finish;
      void this.sleepFn(ms).then(finish, finish);
    });
  }

  private abortPendingSleep(): void {
    if (this.abortSleepResolver) {
      const resolver = this.abortSleepResolver;
      this.abortSleepResolver = null;
      resolver();
    }
  }

  private async notifyCircuitBreakerOpen(): Promise<void> {
    const msg = formatCircuitBreakerOpenMessage();
    const bot = this.telegramBot as unknown as {
      sendMessageToAdmin?: (text: string, options?: unknown) => Promise<unknown>;
      sendAdminMessage?: (text: string, options?: unknown) => Promise<unknown>;
    };
    if (typeof bot.sendMessageToAdmin === 'function') {
      await bot.sendMessageToAdmin(msg, { parse_mode: 'HTML' }).catch(() => {});
    } else if (typeof bot.sendAdminMessage === 'function') {
      await bot.sendAdminMessage(msg, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  public async start(): Promise<void> {
    logger.info(
      `Запуск планировщика (автоотклики: "${this.autoApplyCronPattern}", синхронизация статусов: "${this.syncNegotiationsCronPattern}", автоподнятие: "${this.autoBumpCronPattern}")...`
    );

    await this.checkLlmAvailabilityAndNotify();
    await this.runNegotiationsSyncAndNotify();
    await this.runAutoBumpResume();

    this.llmHealthJob = new Cron('*/5 * * * *', { protect: true }, async () => {
      await this.checkLlmAvailabilityAndNotify();
    });
    this.syncNegotiationsJob = new Cron(this.syncNegotiationsCronPattern, { protect: true }, async () => {
      await this.runNegotiationsSyncAndNotify();
    });
    this.autoBumpResumeJob = new Cron(this.autoBumpCronPattern, { protect: true }, async () => {
      await this.runAutoBumpResume();
    });
    this.autoApplyJob = new Cron(this.autoApplyCronPattern, { protect: true }, async () => {
      await this.runAutoApplyCycle();
    });
    this.syncUnreadMessagesJob = new Cron(this.syncUnreadMessagesCronPattern, { protect: true }, async () => {
      await this.runUnreadMessagesSync();
    });
    this.dailyDigestJob = new Cron('0 0 * * *', { protect: true }, async () => {
      await this.runDailyDigestJob();
    });

    void this.runUnreadMessagesSync();

    if (this.isAutoApplyEnabled()) {
      logger.info('Автоотклики включены (AUTO_APPLY_ENABLED=true). Запуск рабочего цикла...');
      void this.runAutoApplyCycle();
    } else {
      logger.info('Автоотклики сейчас остановлены (AUTO_APPLY_ENABLED=false). Включите их в меню бота.');
    }
  }

  public stop(): void {
    logger.info('Остановка фоновых задач планировщика...');
    this.stopRequested = true;
    this.abortPendingSleep();
    const jobs = [
      this.autoApplyJob,
      this.syncNegotiationsJob,
      this.syncUnreadMessagesJob,
      this.autoBumpResumeJob,
      this.llmHealthJob,
      this.dailyDigestJob,
    ];
    for (const job of jobs) {
      job?.stop();
    }
    this.autoApplyJob = null;
    this.syncNegotiationsJob = null;
    this.syncUnreadMessagesJob = null;
    this.autoBumpResumeJob = null;
    this.llmHealthJob = null;
    this.dailyDigestJob = null;
    logger.info('Планировщик остановлен.');
  }

  public async handleAutoApplyToggled(enabled: boolean): Promise<void> {
    if (!enabled) {
      logger.info('Автоотклики остановлены пользователем.');
      this.stopRequested = true;
      this.abortPendingSleep();
      return;
    }
    logger.info('Автоотклики запущены пользователем. Старт цикла поиска вакансий...');
    void this.runAutoApplyCycle();
  }

  public async runDailyDigestJob(): Promise<void> {
    if (this.queueService && typeof this.queueService.pruneCompletedAndFailedTasks === 'function') {
      this.queueService.pruneCompletedAndFailedTasks(7);
    }
  }

  public async handleDailyLimitUpdated(newLimit: number): Promise<void> {
    this.lastLimitNotifiedDateKey = null;
    if (!this.isAutoApplyEnabled()) {
      return;
    }
    const todayCount = this.countTodayApplications();
    const effectiveLimit = Math.max(1, Math.min(MAX_HARD_DAILY_LIMIT, newLimit));
    if (
      todayCount < effectiveLimit &&
      !this.isCycleRunning &&
      !this.captchaService?.isAwaitingCaptcha()
    ) {
      logger.info(
        `Дневной лимит увеличен до ${effectiveLimit} (сегодня отправлено: ${todayCount}). Автовозобновление автооткликов...`
      );
      void this.runAutoApplyCycle();
    }
  }

  public async runAutoBumpResume(): Promise<SafeResult<'bumped' | 'not_ready' | 'disabled'>> {
    if (this.configStore.isAutoBumpResumeEnabled().data === false) {
      return { data: 'disabled', error: null };
    }

    if (this.captchaService?.isAwaitingCaptcha()) {
      return { data: 'not_ready', error: null };
    }

    if (!this.isHhLoggedIn()) {
      return { data: 'not_ready', error: null };
    }

    const bumpRes = await this.hhHybrid.bumpResume();
    if (bumpRes.error) {
      logger.warn(`Ошибка автоподнятия резюме: ${bumpRes.error}`);
      return { data: null, error: bumpRes.error };
    }

    if (bumpRes.data === 'bumped') {
      logger.info('Автоподнятие резюме: резюме успешно поднято в поиске HH.ru.');
      await this.telegramBot.sendAdminMessage('⬆️ Ваше резюме успешно поднято в поиске HH');
      return { data: 'bumped', error: null };
    }

    logger.info('Автоподнятие резюме: кнопка пока недоступна (таймаут 4 часа еще не истек).');
    return { data: 'not_ready', error: null };
  }

  public countTodayApplications(): number {
    return countTodayAppliedRecords(this.db);
  }

  public countPendingApprovals(): number {
    const rows = this.db
      .select({ id: applicationRecords.id })
      .from(applicationRecords)
      .where(eq(applicationRecords.status, 'pending_approval'))
      .limit(100)
      .all();

    return rows.length;
  }

  public async runAutoApplyCycle(): Promise<SafeResult<AutoApplyCycleSummary>> {
    if (!this.hhCircuitBreaker.canExecute()) {
      logger.warn('Цикл автооткликов пропущен: CircuitBreaker активен (HH.ru временно недоступен).');
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: false },
        error: null,
      };
    }

    if (this.isCycleRunning || this.captchaService?.isAwaitingCaptcha()) {
      logger.info('Цикл автооткликов уже выполняется или ожидает капчу, пропуск повторного запуска.');
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: false },
        error: null,
      };
    }

    if (!this.isAutoApplyEnabled()) {
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: false },
        error: null,
      };
    }

    if (!this.isHhLoggedIn()) {
      logger.warn('Цикл автооткликов пропущен: не выполнен вход в HH.ru (HH_IS_LOGGED_IN=false).');
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: false },
        error: null,
      };
    }

    const dailyLimit = this.resolveClampedDailyLimit();
    const initialTodayCount = this.countTodayApplications();

    if (initialTodayCount >= dailyLimit) {
      logger.info(`Дневной лимит откликов достигнут (${initialTodayCount}/${dailyLimit}). Ожидание следующих суток.`);
      await this.notifyDailyLimitReachedOnce(dailyLimit);
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: true },
        error: null,
      };
    }

    const profile = this.getActiveProfile();
    const filter = this.getActiveFilter();

    if (!profile || !filter) {
      const msg = 'Отсутствует профиль резюме (user_profile) или поисковый фильтр (search_filters).';
      logger.warn(`Цикл автооткликов не может быть запущен: ${msg}`);
      return {
        data: null,
        error: msg,
      };
    }

    const llmStatus = await this.checkLlmAvailabilityAndNotify();
    if (llmStatus.error || !llmStatus.data) {
      logger.warn(`Цикл автооткликов пропущен: локальная языковая модель недоступна (${llmStatus.error}).`);
      return {
        data: { appliedCount: 0, skippedCount: 0, limitReached: false },
        error: `LLM unavailable: ${llmStatus.error}`,
      };
    }

    this.isCycleRunning = true;
    this.stopRequested = false;
    try {
      logger.info(
        `Поиск вакансий по запросу "${filter.queryText}" (сегодня отправлено: ${initialTodayCount}/${dailyLimit})...`
      );

      let appliedCount = 0;
      let skippedCount = 0;
      let limitReached = false;
      const seenVacancyIds = new Set<string>();
      const maxSearchPages = 10;

      for (let page = 0; page < maxSearchPages; page++) {
        if (this.stopRequested || !this.isAutoApplyEnabled()) {
          break;
        }

        const searchResult = await this.hhHybrid.searchVacancies({
          queryText: filter.queryText,
          excludedWords: filter.excludedWords,
          areaId: filter.areaId,
          schedule: filter.schedule,
          salaryFrom: filter.salaryFrom,
          page,
          perPage: 50,
        });

        if (searchResult.error || !searchResult.data) {
          const opened = this.hhCircuitBreaker.recordFailure();
          if (opened) {
            await this.notifyCircuitBreakerOpen();
          }
          if (page === 0) {
            const errMsg = searchResult.error ?? 'Failed to search vacancies';
            logger.error(`Ошибка поиска вакансий: ${errMsg}`);
            return { data: null, error: errMsg };
          }
          break;
        }
        this.hhCircuitBreaker.recordSuccess();

        const pageItems = searchResult.data.items.filter((item) => !seenVacancyIds.has(item.id));
        if (pageItems.length === 0) {
          break;
        }
        for (const item of pageItems) {
          seenVacancyIds.add(item.id);
        }

        const unappliedVacancies = this.filterUnappliedVacancies(pageItems);
        logger.info(
          `Страница ${page + 1}: найдено вакансий: ${pageItems.length}, новых для отклика: ${unappliedVacancies.length}.`
        );
        skippedCount += pageItems.length - unappliedVacancies.length;

        let abortedPage = false;
        for (let idx = 0; idx < unappliedVacancies.length; idx++) {
          if (this.stopRequested || !this.isAutoApplyEnabled()) {
            logger.info('Цикл автооткликов прерван (автоотклики отключены).');
            abortedPage = true;
            break;
          }

          if (!this.hhCircuitBreaker.canExecute()) {
            logger.warn('Цикл автооткликов прерван: CircuitBreaker заблокировал запросы к HH.ru.');
            abortedPage = true;
            break;
          }

          if (
            this.configStore.getApprovalMode().data === 'manual' &&
            this.countPendingApprovals() >= this.maxPendingApprovals
          ) {
            logger.info(
              `Достигнут лимит очереди карточек на ручное одобрение (${this.countPendingApprovals()}/${this.maxPendingApprovals}). Завершение цикла.`
            );
            abortedPage = true;
            break;
          }

          const currentLimit = this.resolveClampedDailyLimit();
          const currentTodayCount = this.countTodayApplications();

          if (currentTodayCount >= currentLimit) {
            limitReached = true;
            logger.info(`Достигнут дневной лимит (${currentTodayCount}/${currentLimit}). Завершение цикла.`);
            await this.notifyDailyLimitReachedOnce(currentLimit);
            abortedPage = true;
            break;
          }

          const item = unappliedVacancies[idx]!;

          if (filter.excludedWords) {
            const excludedList = (typeof filter.excludedWords === 'string'
              ? filter.excludedWords.split(/[,\s]+/)
              : Array.isArray(filter.excludedWords)
                ? filter.excludedWords
                : []
            )
              .map((w: string) => w.trim().toLowerCase())
              .filter((w: string) => w.length > 0);

            const titleLower = item.name.toLowerCase();
            const isExcluded = excludedList.some((w: string) => titleLower.includes(w));
            if (isExcluded) {
              logger.info(`Вакансия "${item.name}" (ID: ${item.id}) отфильтрована по excludedWords.`);
              skippedCount += 1;
              continue;
            }
          }

          logger.info(
            `[${idx + 1}/${unappliedVacancies.length}] Обработка вакансии "${item.name}" (ID: ${item.id})...`
          );
          const appliedResult = await this.processSingleVacancyApplication(item, profile);

          if (appliedResult.queuedForApproval) {
            skippedCount += 1;
            if (
              idx + 1 < unappliedVacancies.length &&
              !this.stopRequested &&
              this.isAutoApplyEnabled() &&
              this.countPendingApprovals() < this.maxPendingApprovals
            ) {
              await this.interruptibleSleep(this.manualApprovalDelayMs);
            }
            continue;
          }

          if (!appliedResult.applied) {
            skippedCount += 1;
            if (this.isLlmUnavailableNotified || this.stopRequested) {
              logger.warn('Цикл автооткликов прерван.');
              abortedPage = true;
              break;
            }
            continue;
          }

          appliedCount += 1;

          const updatedTodayCount = this.countTodayApplications();
          logger.info(
            `Отклик успешно отправлен (${updatedTodayCount}/${currentLimit} за сегодня): "${item.name}".`
          );

          const hasMoreCandidates = idx + 1 < unappliedVacancies.length || searchResult.data.items.length >= 20;
          const delayMs =
            hasMoreCandidates && updatedTodayCount < currentLimit
              ? computeRandomDelayMs(this.minDelayMs, this.maxDelayMs)
              : 0;

          await this.notifyApplicationSentRealtime(appliedResult, updatedTodayCount, currentLimit, delayMs);

          if (updatedTodayCount >= currentLimit) {
            limitReached = true;
            logger.info(`Достигнут дневной лимит (${updatedTodayCount}/${currentLimit}). Завершение цикла.`);
            await this.notifyDailyLimitReachedOnce(currentLimit);
            abortedPage = true;
            break;
          }

          if (hasMoreCandidates && !this.stopRequested && this.isAutoApplyEnabled()) {
            logger.info(`Пауза перед следующим откликом: ${Math.round(delayMs / 1000)} сек...`);
            await this.interruptibleSleep(delayMs);
          }
        }

        if (abortedPage || limitReached || searchResult.data.items.length < 20) {
          break;
        }
      }

      logger.info(
        `Цикл автооткликов завершен: отправлено=${appliedCount}, пропущено=${skippedCount}, лимит=${limitReached}.`
      );

      return {
        data: {
          appliedCount,
          skippedCount,
          limitReached,
        },
        error: null,
      };
    } catch (err) {
      logger.error('Непредвиденная ошибка в цикле автооткликов', err);
      const message = err instanceof Error ? err.message : 'Auto-apply cycle error';
      return { data: null, error: message };
    } finally {
      this.isCycleRunning = false;
      if (this.llm.unloadModel) {
        await this.llm.unloadModel().catch(() => {});
      }
    }
  }

  public async runNegotiationsSyncAndNotify(): Promise<SafeResult<SyncNotificationsSummary>> {
    if (this.captchaService?.isAwaitingCaptcha()) {
      return { data: { syncedUpdatedCount: 0, notifiedCount: 0 }, error: null };
    }
    let syncedUpdatedCount = 0;

    if (this.isHhLoggedIn()) {
      logger.info('Синхронизация статусов откликов на HH.ru (/applicant/negotiations)...');
      const syncResult = await this.hhHybrid.syncNegotiations();
      if (syncResult.error && syncResult.error !== 'ABORTED_BROWSER_CLOSED') {
        logger.error(`Ошибка синхронизации статусов HH.ru: ${syncResult.error}`);
      } else if (syncResult.data) {
        syncedUpdatedCount = syncResult.data.updatedCount;
        logger.info(
          `Статусы HH.ru проверены (проверено: ${syncResult.data.checkedCount}, изменений статуса: ${syncedUpdatedCount}).`
        );
      }
    } else {
      logger.info('Пропуск синхронизации HH.ru: сессия не авторизована (HH_IS_LOGGED_IN=false).');
    }

    const notifiedCount = await notifyPendingEmployerUpdates(this.db, this.telegramBot);
    if (notifiedCount > 0) {
      logger.info(`Отправлено уведомлений в Telegram об изменении статусов: ${notifiedCount}.`);
    }

    return {
      data: {
        syncedUpdatedCount,
        notifiedCount,
      },
      error: null,
    };
  }

  public async runUnreadMessagesSync(): Promise<SafeResult<{ checkedCount: number; notifiedCount: number }>> {
    if (!this.hhMessaging || this.captchaService?.isAwaitingCaptcha()) {
      return { data: { checkedCount: 0, notifiedCount: 0 }, error: null };
    }
    const sendFn = this.telegramBot.sendUnreadChatNotification?.bind(this.telegramBot)
      ?? (async () => ({ data: null, error: 'Telegram notification not supported' }));
    return syncUnreadMessagesCore({
      db: this.db,
      hhMessaging: this.hhMessaging,
      sendUnreadChatNotification: sendFn,
    });
  }

  private async processSingleVacancyApplication(
    item: HhVacancyShortItem,
    profile: UserProfile
  ): Promise<SingleApplicationResult> {
    if (item.archived) {
      logger.info(`Вакансия ${item.id} в архиве, пропуск.`);
      return { applied: false };
    }

    const detailsResult = await this.hhHybrid.getVacancyDetails(item.id);
    if (detailsResult.error || !detailsResult.data) {
      const opened = this.hhCircuitBreaker.recordFailure();
      if (opened) {
        await this.notifyCircuitBreakerOpen();
      }
      logger.warn(
        `Не удалось получить детали вакансии ${item.id}: ${detailsResult.error ?? 'нет данных'}`
      );
      return { applied: false };
    }
    this.hhCircuitBreaker.recordSuccess();

    const { vacancy, cleanDescription, salaryText } = detailsResult.data;
    if (vacancy.archived || cleanDescription.length < 10) {
      logger.info(`Вакансия ${item.id} в архиве или описание пустое, пропуск.`);
      return { applied: false };
    }

    const companyName = vacancy.employer?.name ?? item.employer?.name ?? 'Unknown Company';
    if (this.configStore.isCompanyBlacklisted(companyName).data === true) {
      logger.info(`Компания "${companyName}" в черном списке, пропуск вакансии ${vacancy.id}.`);
      return { applied: false };
    }

    const minMatchScore = this.configStore.getMinMatchScore().data ?? 70;
    logger.info(`Оценка соответствия вакансии "${vacancy.name}" (${companyName}) через LLM...`);

    const isCacheable = !isAnonymousCompany(companyName);
    const profileFingerprint = createHash('sha1')
      .update(`${profile.resumeRawText}::${profile.customPromptRules ?? ''}::${minMatchScore}`)
      .digest('hex')
      .slice(0, 12);
    const companyKey = companyName.trim().toLowerCase();
    const titleKey = (vacancy.name || item.name || '').trim().toLowerCase();
    const evalCacheKey = `${companyKey}::${titleKey}::${profileFingerprint}`;

    let matchScore: number;
    let reasoning: string;
    let coverLetter: string;

    const cachedEval = isCacheable ? this.evaluationCache.get(evalCacheKey) : undefined;
    if (cachedEval) {
      matchScore = cachedEval.matchScore;
      reasoning = cachedEval.reasoning;
      coverLetter = cachedEval.coverLetter ?? '';
    } else {
      const evalResult = await this.llm.evaluateVacancy({
        resumeRawText: profile.resumeRawText,
        vacancyTitle: vacancy.name,
        companyName,
        vacancyDescription: cleanDescription,
        customPromptRules: profile.customPromptRules,
        minMatchScore,
      });

      if (evalResult.error || !evalResult.data) {
        logger.error(
          `Ошибка оценки вакансии ${vacancy.id} ("${vacancy.name}"): ${evalResult.error ?? 'пустой ответ'}`
        );
        await this.checkLlmAvailabilityAndNotify();
        return { applied: false };
      }

      matchScore = evalResult.data.matchScore;
      reasoning = evalResult.data.reasoning;
      coverLetter = evalResult.data.coverLetter;

      if (isCacheable) {
        if (this.evaluationCache.size >= 500) {
          const firstKey = this.evaluationCache.keys().next().value;
          if (firstKey) {
            this.evaluationCache.delete(firstKey);
          }
        }
        this.evaluationCache.set(evalCacheKey, { matchScore, reasoning, coverLetter });
      }
    }

    const nowIso = new Date().toISOString();
    const recordBase = {
      vacancyId: vacancy.id,
      companyName,
      positionTitle: vacancy.name,
      salaryText,
      vacancyUrl: vacancy.alternate_url,
      matchScore,
      aiReasoning: reasoning,
      isNotified: true,
      appliedAt: nowIso,
      updatedAt: nowIso,
    };

    if (matchScore < minMatchScore) {
      logger.info(
        `Вакансия ${vacancy.id} пропущена: балл соответствия ${matchScore} ниже порога ${minMatchScore}. Причина: ${reasoning}`
      );
      this.saveApplicationRecord({
        ...recordBase,
        coverLetter: '',
        status: 'skipped_low_score',
        lastEmployerMessage: null,
      });
      return { applied: false };
    }

    if (this.configStore.getApprovalMode().data === 'manual') {
      logger.info(
        `Вакансия ${vacancy.id} (${matchScore}/100) помещена в очередь ручного одобрения.`
      );
      this.saveApplicationRecord({
        ...recordBase,
        coverLetter,
        status: 'pending_approval',
        lastEmployerMessage: null,
      });

      const insertedRow = this.db
        .select()
        .from(applicationRecords)
        .where(eq(applicationRecords.vacancyId, vacancy.id))
        .limit(1)
        .get();

      if (insertedRow && typeof this.telegramBot.sendApprovalCard === 'function') {
        await this.telegramBot.sendApprovalCard(insertedRow);
      }

      return { applied: false, queuedForApproval: true };
    }

    logger.info(
      `Отправка отклика через Playwright на ${vacancy.alternate_url} (${coverLetter.length} симв.)...`
    );
    const skipForeign = this.configStore.isSkipForeignVacanciesEnabled?.().data ?? true;
    const applyResult = await this.hhHybrid.applyToVacancy({
      vacancyId: vacancy.id,
      vacancyUrl: vacancy.alternate_url,
      resumeTitle: profile.hhResumeTitle,
      coverLetter,
      skipForeignVacancies: skipForeign,
    });

    if (applyResult.error === 'CAPTCHA_REQUIRED') {
      logger.warn(`HH.ru потребовал прохождение капчи для вакансии ${vacancy.id}`);
      await this.captchaService?.handleCaptchaDetected({
        detected: true,
        pageUrl: vacancy.alternate_url,
      });
      this.stopRequested = true;
      return { applied: false };
    }

    if (applyResult.error === 'ALREADY_APPLIED') {
      logger.info(`Вакансия ${vacancy.id} уже была отправлена ранее, сохраняем в истории.`);
      this.saveApplicationRecord({ ...recordBase, coverLetter, status: 'response', lastEmployerMessage: null });
      return { applied: false };
    }

    if (applyResult.error === 'FOREIGN_VACANCY') {
      logger.info(`Вакансия ${vacancy.id} ("${vacancy.name}") пропущена: работодатель или вакансия находится в другой стране.`);
      this.saveApplicationRecord({ ...recordBase, coverLetter, status: 'skipped_user', lastEmployerMessage: 'Вакансия/работодатель находится в другой стране' });
      return { applied: false };
    }

    if (applyResult.error === 'QUESTIONS_REQUIRED') {
      logger.info(`Вакансия ${vacancy.id} ("${vacancy.name}") требует ответов на вопросы работодателя или теста.`);
      this.saveApplicationRecord({ ...recordBase, coverLetter, status: 'pending_approval', lastEmployerMessage: 'Требуется ручное прохождение теста' });
      const escalation = formatEmployerQuestionsEscalationText(vacancy.name, vacancy.alternate_url, companyName, coverLetter);
      await this.telegramBot.sendAdminMessage(escalation, { parse_mode: 'HTML' });
      return { applied: false };
    }

    if (applyResult.error || !applyResult.data) {
      logger.error(`Ошибка отправки отклика в браузере для вакансии ${vacancy.id}: ${applyResult.error ?? 'не удалось отправить'}`);
      this.saveApplicationRecord({ ...recordBase, coverLetter, status: 'skipped_user', lastEmployerMessage: applyResult.error ?? 'Ошибка браузерного отклика' });
      return { applied: false };
    }

    this.saveApplicationRecord({ ...recordBase, coverLetter, status: 'response', lastEmployerMessage: null });

    return {
      applied: true,
      companyName,
      positionTitle: vacancy.name,
      salaryText,
      vacancyUrl: vacancy.alternate_url,
    };
  }

  private saveApplicationRecord(values: typeof applicationRecords.$inferInsert): void {
    this.db.insert(applicationRecords).values(values).onConflictDoNothing({ target: applicationRecords.vacancyId }).run();
  }

  private filterUnappliedVacancies(items: ReadonlyArray<HhVacancyShortItem>): HhVacancyShortItem[] {
    return filterUnappliedVacancies(this.db, this.configStore, items);
  }

  private async notifyDailyLimitReachedOnce(limit: number): Promise<void> {
    const todayKey = getLocalDayKey();
    if (this.lastLimitNotifiedDateKey === todayKey) return;
    this.lastLimitNotifiedDateKey = todayKey;
    await this.telegramBot.sendAdminMessage(formatDailyLimitReachedMessage(limit));
  }

  public async checkLlmAvailabilityAndNotify(): Promise<SafeResult<boolean>> {
    const statusRes = await this.llm.inspectStatus();
    if (
      statusRes.error ||
      !statusRes.data ||
      !statusRes.data.isOnline ||
      !statusRes.data.isConfiguredModelInstalled
    ) {
      const reason = !statusRes.data?.isOnline
        ? (statusRes.data?.error ?? statusRes.error ?? 'Сервер Ollama недоступен')
        : `Модель "${statusRes.data.configuredModel}" не установлена на сервере`;

      if (!this.isLlmUnavailableNotified) {
        this.isLlmUnavailableNotified = true;
        const host = statusRes.data?.baseUrl ?? 'http://127.0.0.1:11434';
        const model = statusRes.data?.configuredModel ?? 'не указана';
        await this.telegramBot.sendAdminMessage(formatLlmUnavailableMessage(host, model, reason));
      }
      return { data: false, error: reason };
    }

    if (this.isLlmUnavailableNotified) {
      this.isLlmUnavailableNotified = false;
      await this.telegramBot.sendAdminMessage(
        formatLlmRestoredMessage(statusRes.data.configuredModel)
      );
    }

    return { data: true, error: null };
  }

  private resolveClampedDailyLimit(): number {
    return Math.max(1, Math.min(MAX_HARD_DAILY_LIMIT, this.configStore.getDailyLimit().data ?? 50));
  }

  private isAutoApplyEnabled(): boolean {
    return this.configStore.get('AUTO_APPLY_ENABLED').data === 'true';
  }

  private isHhLoggedIn(): boolean {
    return this.configStore.get('HH_IS_LOGGED_IN').data === 'true';
  }

  private getActiveProfile(): UserProfile | null {
    return this.db.select().from(userProfiles).limit(1).get() ?? null;
  }

  private getActiveFilter(): SearchFilter | null {
    return this.db.select().from(searchFilters).limit(1).get() ?? null;
  }

  private async notifyApplicationSentRealtime(
    info: SingleApplicationResult,
    todayCount: number,
    limit: number,
    delayMs: number
  ): Promise<void> {
    await this.telegramBot.sendAdminMessage(formatAutoAppliedMessage(info, todayCount, limit, delayMs));
  }
}
