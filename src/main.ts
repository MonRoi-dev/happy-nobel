import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { InputFile } from 'grammy';
import { eq } from 'drizzle-orm';
import { createDatabaseContext, type DatabaseContext } from './db/index.ts';
import { applicationRecords, userProfiles } from './db/schema.ts';
import {
  ConfigStoreService,
  TelegramAdminIdSchema,
  TelegramBotTokenSchema,
  type IConfigStore,
  type SafeResult,
} from './modules/config-store/index.ts';
import {
  ExcelExporterService,
  GoogleSheetsExporterService,
  type IReportExporter,
} from './modules/exporter/index.ts';
import {
  HhBrowserCaptchaService,
  HhHybridService,
  HhMessagingService,
  type IHhBrowserCaptchaService,
  type IHhHybridService,
  type IHhMessagingService,
} from './modules/hh-hybrid/index.ts';
import {
  GamingModeService,
  LlmReplyService,
  LlmService,
  type IGamingModeService,
  type ILlmReplyService,
  type ILlmService,
} from './modules/llm/index.ts';
import { ContactExtractorService } from './modules/parser/index.ts';
import {
  QueueWorkerService,
  SqliteQueueService,
  type ISqliteQueueService,
} from './modules/queue/index.ts';
import { SchedulerService, type ISchedulerService } from './modules/scheduler/index.ts';
import { TelegramBotService, type ITelegramBotService } from './modules/telegram/index.ts';
import {
  ExternalFormApplierService,
  TgChannelScraperService,
  type IExternalFormApplierService,
  type ITgChannelScraperService,
} from './modules/tg-channel/index.ts';
import { createLogger, formatErrorDetails } from './utils/logger.ts';

const logger = createLogger('Main');

export interface BootstrapCredentials {
  readonly botToken: string;
  readonly adminId: string;
}

export interface ApplicationContainer {
  readonly dbContext: DatabaseContext;
  readonly configStore: IConfigStore;
  readonly hhHybrid: IHhHybridService;
  readonly hhMessaging?: IHhMessagingService;
  readonly llm: ILlmService;
  readonly llmReply?: ILlmReplyService;
  readonly gamingMode?: IGamingModeService;
  readonly excelExporter: IReportExporter;
  readonly googleSheetsExporter: IReportExporter;
  readonly telegramBot: ITelegramBotService;
  readonly scheduler: ISchedulerService;
  readonly sqliteQueue: ISqliteQueueService;
  readonly queueWorker: QueueWorkerService;
  readonly captchaService: IHhBrowserCaptchaService;
  readonly contactExtractor: ContactExtractorService;
  readonly tgChannelScraper?: ITgChannelScraperService;
  readonly externalFormApplier?: IExternalFormApplierService;
}

export interface CliPromptAdapter {
  question(promptText: string): Promise<string>;
  close(): void;
}

function createReadlinePromptAdapter(): CliPromptAdapter {
  const rl = createInterface({ input, output });
  return {
    async question(promptText: string): Promise<string> {
      return rl.question(promptText);
    },
    close(): void {
      rl.close();
    },
  };
}

function maskToken(token: string): string {
  if (token.length <= 10) {
    return '***';
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function promptValidBotToken(adapter: CliPromptAdapter): Promise<SafeResult<string>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rawToken = await adapter.question('Enter Telegram Bot Token (TG_BOT_TOKEN): ');
    const parsed = TelegramBotTokenSchema.safeParse(rawToken);
    if (parsed.success) {
      return { data: parsed.data, error: null };
    }
    output.write(`[Validation Error] ${parsed.error.issues[0]?.message ?? 'Invalid token format'}\n`);
  }
  return { data: null, error: 'Maximum retry attempts exceeded for TG_BOT_TOKEN' };
}

async function promptValidAdminId(adapter: CliPromptAdapter): Promise<SafeResult<string>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rawAdminId = await adapter.question('Enter your Telegram User ID (TG_ADMIN_ID): ');
    const parsed = TelegramAdminIdSchema.safeParse(rawAdminId);
    if (parsed.success) {
      return { data: parsed.data, error: null };
    }
    output.write(`[Validation Error] ${parsed.error.issues[0]?.message ?? 'Invalid Telegram ID'}\n`);
  }
  return { data: null, error: 'Maximum retry attempts exceeded for TG_ADMIN_ID' };
}

export async function ensureCliBootstrapCredentials(
  configStore: IConfigStore,
  customPromptAdapter?: CliPromptAdapter
): Promise<SafeResult<BootstrapCredentials>> {
  const defaultsInit = configStore.ensureDefaults();
  if (defaultsInit.error) {
    return { data: null, error: defaultsInit.error };
  }

  const existing = configStore.getBootstrapCredentials();
  if (existing.error) {
    return { data: null, error: existing.error };
  }

  if (existing.data) {
    return { data: existing.data, error: null };
  }

  const envToken = process.env.TG_BOT_TOKEN;
  const envAdminId = process.env.TG_ADMIN_ID;

  if (envToken && envAdminId) {
    const savedFromEnv = configStore.saveBootstrapCredentials(envToken, envAdminId);
    if (!savedFromEnv.error && savedFromEnv.data) {
      return { data: savedFromEnv.data, error: null };
    }
  }

  const adapter = customPromptAdapter ?? createReadlinePromptAdapter();
  try {
    output.write('=== First Run Setup: Telegram Bot Configuration ===\n');

    const tokenResult = await promptValidBotToken(adapter);
    if (tokenResult.error || !tokenResult.data) {
      return { data: null, error: tokenResult.error ?? 'Failed to read TG_BOT_TOKEN' };
    }

    const adminResult = await promptValidAdminId(adapter);
    if (adminResult.error || !adminResult.data) {
      return { data: null, error: adminResult.error ?? 'Failed to read TG_ADMIN_ID' };
    }

    const saved = configStore.saveBootstrapCredentials(tokenResult.data, adminResult.data);
    if (saved.error || !saved.data) {
      return { data: null, error: saved.error ?? 'Failed to persist credentials' };
    }

    return { data: saved.data, error: null };
  } finally {
    adapter.close();
  }
}

export async function createApplicationContainer(
  dbFileName = 'database.sqlite'
): Promise<SafeResult<ApplicationContainer>> {
  logger.info(`Инициализация базы данных SQLite (${dbFileName})...`);
  const dbContext = createDatabaseContext(dbFileName);
  const configStore = new ConfigStoreService(dbContext.db);
  const credentialsResult = await ensureCliBootstrapCredentials(configStore);

  if (credentialsResult.error || !credentialsResult.data) {
    logger.error(`Ошибка инициализации учетных данных: ${credentialsResult.error ?? 'Bootstrap failed'}`);
    dbContext.close();
    return { data: null, error: credentialsResult.error ?? 'Bootstrap failed' };
  }

  const gamingMode = new GamingModeService(configStore);
  const llm = new LlmService(configStore, undefined, gamingMode);
  const llmReply = new LlmReplyService(configStore, { gamingModeService: gamingMode });
  const hhHybrid = new HhHybridService(configStore, dbContext.db, {
    questionSolver: async (context, questions) => {
      if (configStore.isAnswerQuestionsEnabled().data === false) {
        return { data: null, error: 'ANSWER_QUESTIONS_DISABLED' };
      }
      const profile = dbContext.db.select().from(userProfiles).limit(1).get();
      if (!profile) {
        return { data: null, error: 'NO_USER_PROFILE' };
      }
      let vacancyTitle = context.vacancyTitle;
      let companyName = context.companyName;
      if (!vacancyTitle || !companyName) {
        const record = dbContext.db
          .select()
          .from(applicationRecords)
          .where(eq(applicationRecords.vacancyId, context.vacancyId))
          .limit(1)
          .get();
        if (record) {
          vacancyTitle = vacancyTitle ?? record.positionTitle;
          companyName = companyName ?? record.companyName;
        }
      }
      return llm.answerEmployerQuestions({
        resumeRawText: profile.resumeRawText,
        vacancyTitle: vacancyTitle ?? 'Vacancy Application',
        companyName: companyName ?? 'Employer',
        questions: [...questions],
      });
    },
  });
  const hhMessaging = new HhMessagingService(hhHybrid);
  const excelExporter = new ExcelExporterService(dbContext.db);
  const googleSheetsExporter = new GoogleSheetsExporterService(dbContext.db);

  const sqliteQueue = new SqliteQueueService(dbContext.db, dbContext.sqlite);
  sqliteQueue.recoverStaleProcessingTasks();

  const queueWorker = new QueueWorkerService(sqliteQueue);
  const contactExtractor = new ContactExtractorService();
  const tgChannelScraper = new TgChannelScraperService();
  const externalFormApplier = new ExternalFormApplierService();

  let schedulerRef: ISchedulerService | null = null;
  let telegramBotRef: ITelegramBotService | null = null;

  const captchaService = new HhBrowserCaptchaService({
    hhHybrid,
    queueService: sqliteQueue,
    onNotifyCaptcha: async (snap) => {
      if (telegramBotRef && typeof telegramBotRef.sendCaptchaAlert === 'function') {
        return telegramBotRef.sendCaptchaAlert(snap);
      }
      return { data: false, error: 'Telegram bot not ready' };
    },
    onCaptchaResolved: async () => {
      if (schedulerRef && configStore.get('AUTO_APPLY_ENABLED').data === 'true') {
        await schedulerRef.handleAutoApplyToggled(true);
      }
    },
  });

  const telegramBot = new TelegramBotService(
    credentialsResult.data.botToken,
    configStore,
    dbContext.db,
    hhHybrid,
    llm,
    {
      hhMessaging,
      llmReply,
      captchaService,
      gamingModeService: gamingMode,
      onExportRequested: async (ctx) => {
        const exportResult = await excelExporter.exportApplicationsReport();
        if (exportResult.error || !exportResult.data) {
          await ctx.reply(
            `❌ Ошибка формирования отчета: ${exportResult.error ?? 'неизвестная ошибка'}`
          );
          return;
        }

        const { buffer, fileName, rowCount } = exportResult.data;
        await ctx.replyWithDocument(new InputFile(buffer, fileName), {
          caption: `📊 Отчет по откликам HH.ru (записей: ${rowCount})`,
        });
      },
      onAutoApplyToggled: async (enabled: boolean) => {
        if (schedulerRef) {
          await schedulerRef.handleAutoApplyToggled(enabled);
        }
      },
      onDailyLimitUpdated: async (newLimit: number) => {
        if (schedulerRef) {
          await schedulerRef.handleDailyLimitUpdated(newLimit);
        }
      },
    }
  );
  telegramBotRef = telegramBot;

  const scheduler = new SchedulerService(
    configStore,
    dbContext.db,
    hhHybrid,
    llm,
    telegramBot,
    {
      hhMessaging,
      captchaService,
      queueService: sqliteQueue,
      tgChannelScraper,
      externalFormApplier,
    }
  );
  schedulerRef = scheduler;

  queueWorker.registerHandler('SEND_TG_MESSAGE', async (task) => {
    try {
      const payload = JSON.parse(task.payloadJson) as {
        kind?: string;
        text?: string;
        parse_mode?: 'HTML' | 'MarkdownV2';
      };
      if (payload.kind === 'CAPTCHA_ALERT' && !payload.text) {
        return { data: 'completed', error: null };
      }
      if (!payload.text) {
        return { data: 'completed', error: null };
      }
      const sendRes = await telegramBot.sendAdminMessage(payload.text, { parse_mode: payload.parse_mode });
      if (sendRes.error) {
        return { data: null, error: sendRes.error };
      }
      return { data: 'completed', error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  queueWorker.registerHandler('APPLY_VACANCY', async (task) => {
    try {
      const payload = JSON.parse(task.payloadJson) as {
        vacancyId: string;
        vacancyUrl: string;
        resumeTitle: string;
        coverLetter: string;
      };
      const skipForeign = configStore.isSkipForeignVacanciesEnabled?.().data ?? true;
      const applyRes = await hhHybrid.applyToVacancy({
        ...payload,
        skipForeignVacancies: skipForeign,
      });
      if (applyRes.error === 'CAPTCHA_REQUIRED') {
        await captchaService.handleCaptchaDetected({ detected: true, pageUrl: payload.vacancyUrl }, task.id);
        return { data: 'paused_captcha', error: 'CAPTCHA_REQUIRED' };
      }
      if (applyRes.error === 'FOREIGN_VACANCY') {
        return { data: 'completed', error: null };
      }
      if (applyRes.error && applyRes.error !== 'ALREADY_APPLIED') {
        return { data: null, error: applyRes.error };
      }
      return { data: 'completed', error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  queueWorker.registerHandler('SYNC_NEGOTIATIONS', async () => {
    try {
      const syncRes = await schedulerRef?.runNegotiationsSyncAndNotify();
      if (syncRes && syncRes.error) {
        return { data: null, error: syncRes.error };
      }
      return { data: 'completed', error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const isHhLoggedIn = configStore.get('HH_IS_LOGGED_IN').data === 'true';
  const isAutoApply = configStore.get('AUTO_APPLY_ENABLED').data === 'true';
  const dailyLimit = configStore.getDailyLimit().data ?? 50;

  logger.info(
    `Конфигурация готова | Admin ID: ${credentialsResult.data.adminId} | Bot Token: ${maskToken(
      credentialsResult.data.botToken
    )} | HH.ru вход: ${isHhLoggedIn ? 'ДА' : 'НЕТ'} | Автоотклик: ${
      isAutoApply ? 'ВКЛ' : 'ВЫКЛ'
    } | Лимит: ${dailyLimit}/сут.`
  );

  return {
    data: {
      dbContext,
      configStore,
      hhHybrid,
      hhMessaging,
      llm,
      llmReply,
      gamingMode,
      excelExporter,
      googleSheetsExporter,
      telegramBot,
      scheduler,
      sqliteQueue,
      queueWorker,
      captchaService,
      contactExtractor,
      tgChannelScraper,
      externalFormApplier,
    },
    error: null,
  };
}

export async function bootstrapApplication(
  dbFileName = 'database.sqlite'
): Promise<SafeResult<BootstrapCredentials>> {
  const containerResult = await createApplicationContainer(dbFileName);
  if (containerResult.error || !containerResult.data) {
    return { data: null, error: containerResult.error ?? 'Failed to initialize application' };
  }

  const { dbContext, configStore, telegramBot, scheduler, queueWorker, gamingMode, hhHybrid } = containerResult.data;
  const creds = configStore.getBootstrapCredentials();

  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    logger.info(`Получен сигнал ${signal}. Корректное завершение работы...`);

    try {
      await queueWorker.stop();
    } catch (err) {
      logger.error('Ошибка при остановке воркера очереди', err);
    }

    try {
      scheduler.stop();
    } catch (err) {
      logger.error('Ошибка при остановке планировщика', err);
    }

    try {
      await telegramBot.stop();
    } catch (err) {
      logger.error('Ошибка при остановке Telegram-бота', err);
    }

    try {
      await gamingMode?.stop();
    } catch (err) {
      logger.error('Ошибка при остановке сервиса игрового режима NPU', err);
    }

    try {
      await hhHybrid.closeWarmSession?.();
    } catch (err) {
      logger.error('Ошибка при закрытии прогретой сессии браузера', err);
    }

    try {
      dbContext.close();
      logger.info('Соединение с базой данных SQLite закрыто. Выход.');
    } catch (err) {
      logger.error('Ошибка при закрытии базы данных SQLite', err);
    }

    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await gamingMode?.start();
    queueWorker.start();
    await telegramBot.start();
    await scheduler.start();
    logger.info('Все сервисы успешно запущены и работают в штатном режиме (нажмите Ctrl+C для выхода).');
    return creds;
  } catch (err) {
    const details = formatErrorDetails(err) || 'Startup error';
    logger.error('Ошибка при запуске сервисов приложения', err);
    return { data: null, error: details };
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  process.on('unhandledRejection', (reason) => {
    logger.error('Необработанное отклонение промиса (Unhandled Rejection)', reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Неперехваченное исключение (Uncaught Exception)', err);
  });

  bootstrapApplication().then((res) => {
    if (res.error) {
      logger.error(`Фатальная ошибка запуска: ${res.error}`);
      process.exitCode = 1;
    }
  });
}
