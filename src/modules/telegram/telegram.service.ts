import https from 'node:https';
import { conversations } from '@grammyjs/conversations';
import { and, gte, notInArray } from 'drizzle-orm';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AppDatabase } from '../../db/index.ts';
import { applicationRecords, searchFilters, userProfiles, type ApplicationRecord, type NegotiationMessageRecord, type SearchFilter, type UserProfile } from '../../db/schema.ts';
import { createLogger, formatErrorDetails } from '../../utils/logger.ts';
import type { IConfigStore, SafeResult } from '../config-store/index.ts';
import type {
  CaptchaChallengeSnapshot,
  IHhBrowserCaptchaService,
  IHhHybridService,
  IHhMessagingService,
} from '../hh-hybrid/index.ts';
import type { IGamingModeService, ILlmReplyService, ILlmService } from '../llm/index.ts';
import { agentLogger } from '../logger/index.ts';
import { registerCaptchaHandlers, sendCaptchaAlertToAdmin } from './telegram-captcha.handler.ts';
import { registerStatusHandlers } from './telegram-status.handler.ts';
import {
  BOT_MENU_COMMANDS, buildAutomationSettingsKeyboard, buildAutomationSettingsText,
  buildBlacklistKeyboard, buildBlacklistText, escapeHtml, formatBytes, registerBlacklistHandlers,
} from './telegram-blacklist.ts';
import {
  buildApprovalCardKeyboard, buildApprovalCardText, handleApprovalAction,
  registerApprovalHandlers, type ApprovalHandlerDeps,
} from './telegram-approval.ts';
import {
  buildRecentErrorsReportText, buildUnreadInitialKeyboard, buildUnreadNotificationText,
  registerMessagingHandlers,
} from './telegram-messaging.handler.ts';
import {
  buildLlmStatusKeyboard, buildLlmStatusText, buildModelPickerKeyboard, extractPdfResumeText,
  parseAndClampDailyLimit, parseAndClampMinMatchScore, registerWizardConversations,
  type BotContext, type BotConversation, type DailyLimitParseResult, type WizardDeps,
} from './telegram-wizards.ts';

const logger = createLogger('Telegram');

export {
  BOT_MENU_COMMANDS, buildApprovalCardKeyboard, buildApprovalCardText, buildAutomationSettingsKeyboard,
  buildAutomationSettingsText, buildBlacklistKeyboard, buildBlacklistText, escapeHtml, extractPdfResumeText,
  formatBytes, handleApprovalAction, parseAndClampDailyLimit, parseAndClampMinMatchScore,
  registerApprovalHandlers, registerBlacklistHandlers, type ApprovalHandlerDeps, type BotContext,
  type BotConversation, type DailyLimitParseResult, type WizardDeps,
};

export interface AdminMessageOptions {
  readonly parse_mode?: 'HTML' | 'MarkdownV2';
  readonly disable_web_page_preview?: boolean;
}

export interface ITelegramBotService {
  readonly bot: Bot<BotContext>;
  start(): Promise<void>;
  stop(): Promise<void>;
  syncBotCommandMenu(): Promise<SafeResult<boolean>>;
  sendAdminMessage(text: string, options?: AdminMessageOptions): Promise<SafeResult<boolean>>;
  sendApprovalCard(record: ApplicationRecord): Promise<SafeResult<boolean>>;
  sendUnreadChatNotification?(record: NegotiationMessageRecord): Promise<SafeResult<number>>;
  sendCaptchaAlert?(snapshot: CaptchaChallengeSnapshot): Promise<SafeResult<boolean>>;
  buildMainMenuKeyboard(): InlineKeyboard;
  buildMainMenuText(): string;
  buildAutomationSettingsKeyboard(): InlineKeyboard;
  buildAutomationSettingsText(): string;
  buildLlmStatusKeyboard(): InlineKeyboard;
  buildLlmStatusText(): Promise<string>;
  buildModelPickerKeyboard(): Promise<{ text: string; keyboard: InlineKeyboard }>;
  countTodayApplications(): number;
}

export interface TelegramBotHooks {
  readonly onExportRequested?: (ctx: Context) => Promise<void>;
  readonly onAutoApplyToggled?: (enabled: boolean) => Promise<void>;
  readonly onDailyLimitUpdated?: (newLimit: number) => Promise<void>;
  readonly hhMessaging?: IHhMessagingService;
  readonly llmReply?: ILlmReplyService;
  readonly captchaService?: IHhBrowserCaptchaService;
  readonly gamingModeService?: IGamingModeService;
}

export class TelegramBotService implements ITelegramBotService {
  public readonly bot: Bot<BotContext>;
  private readonly configStore: IConfigStore;
  private readonly db: AppDatabase;
  private readonly hhHybrid: IHhHybridService;
  private readonly llm: ILlmService;
  private readonly hhMessaging?: IHhMessagingService;
  private readonly llmReply?: ILlmReplyService;
  private readonly captchaService?: IHhBrowserCaptchaService;
  private readonly gamingModeService?: IGamingModeService;
  private readonly onExportRequested?: (ctx: Context) => Promise<void>;
  private readonly onAutoApplyToggled?: (enabled: boolean) => Promise<void>;
  private readonly onDailyLimitUpdated?: (newLimit: number) => Promise<void>;
  private isStopping = false;

  constructor(
    botToken: string,
    configStore: IConfigStore,
    db: AppDatabase,
    hhHybrid: IHhHybridService,
    llm: ILlmService,
    hooks?: TelegramBotHooks
  ) {
    this.configStore = configStore;
    this.db = db;
    this.hhHybrid = hhHybrid;
    this.llm = llm;
    this.hhMessaging = hooks?.hhMessaging;
    this.llmReply = hooks?.llmReply;
    this.captchaService = hooks?.captchaService;
    this.gamingModeService = hooks?.gamingModeService;
    this.onExportRequested = hooks?.onExportRequested;
    this.onAutoApplyToggled = hooks?.onAutoApplyToggled;
    this.onDailyLimitUpdated = hooks?.onDailyLimitUpdated;

    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: 10,
      timeout: 45_000,
    });

    this.bot = new Bot<BotContext>(botToken, {
      client: {
        timeoutSeconds: 45,
        baseFetchConfig: { agent: httpsAgent, compress: true },
      },
    });

    this.registerApiTransformer();
    this.registerMiddlewaresAndHandlers();
  }

  public async start(): Promise<void> {
    this.isStopping = false;
    logger.info('Подключение к Telegram Bot API (проверка токена и инициализация long-polling)...');
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const pollingPromise = this.bot.start({
        timeout: 20,
        onStart: (botInfo) => {
          started = true;
          logger.info(`Бот @${botInfo.username} (ID: ${botInfo.id}) запущен и слушает обновления.`);
          resolve();
        },
      });
      pollingPromise.catch((err) => {
        if (this.isStopping) return resolve();
        logger.error('Критическая ошибка long-polling Telegram-бота', err);
        if (!started) reject(err);
      });
    });
    await this.syncBotCommandMenu();
  }

  public async syncBotCommandMenu(): Promise<SafeResult<boolean>> {
    try {
      await this.bot.api.setMyCommands(BOT_MENU_COMMANDS);
      await this.bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
      logger.info('Кнопка Menu и список команд Telegram-бота синхронизированы.');
      return { data: true, error: null };
    } catch (err) {
      logger.warn(`Не удалось синхронизировать кнопку Menu в Telegram (${formatErrorDetails(err)})`);
      return { data: null, error: formatErrorDetails(err) || 'Failed to sync bot command menu' };
    }
  }

  public async stop(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    logger.info('Остановка Telegram-бота...');
    try {
      await this.bot.stop();
    } catch (err) {
      logger.warn(`Соединение getUpdates закрыто при остановке бота (${formatErrorDetails(err)})`);
    }
    logger.info('Telegram-бот остановлен.');
  }

  public async sendAdminMessage(text: string, options?: AdminMessageOptions): Promise<SafeResult<boolean>> {
    const adminId = this.configStore.get('TG_ADMIN_ID');
    if (adminId.error || !adminId.data) {
      logger.warn('Не удалось отправить уведомление: TG_ADMIN_ID не настроен.');
      return { data: null, error: adminId.error ?? 'TG_ADMIN_ID is not configured' };
    }
    try {
      await this.bot.api.sendMessage(adminId.data, text, {
        parse_mode: options?.parse_mode ?? 'HTML',
        link_preview_options: { is_disabled: options?.disable_web_page_preview ?? false },
      });
      return { data: true, error: null };
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("can't parse entities") || errStr.includes('Bad Request')) {
        try {
          await this.bot.api.sendMessage(adminId.data, text);
          return { data: true, error: null };
        } catch {}
      }
      logger.error('Ошибка отправки сообщения администратору в Telegram', err);
      return { data: null, error: formatErrorDetails(err) || 'Failed to send Telegram message' };
    }
  }

  public async sendApprovalCard(record: ApplicationRecord): Promise<SafeResult<boolean>> {
    const adminId = this.configStore.get('TG_ADMIN_ID');
    if (adminId.error || !adminId.data) {
      logger.warn('Не удалось отправить карточку одобрения: TG_ADMIN_ID не настроен.');
      return { data: null, error: adminId.error ?? 'TG_ADMIN_ID is not configured' };
    }
    try {
      await this.bot.api.sendMessage(adminId.data, buildApprovalCardText(record), {
        parse_mode: 'HTML',
        reply_markup: buildApprovalCardKeyboard(record.id),
        link_preview_options: { is_disabled: true },
      });
      return { data: true, error: null };
    } catch (err) {
      logger.error('Ошибка отправки карточки одобрения администратору в Telegram', err);
      return { data: null, error: formatErrorDetails(err) || 'Failed to send approval card' };
    }
  }

  public async sendUnreadChatNotification(record: NegotiationMessageRecord): Promise<SafeResult<number>> {
    const adminId = this.configStore.get('TG_ADMIN_ID');
    if (adminId.error || !adminId.data) {
      logger.warn('Не удалось отправить уведомление о сообщении: TG_ADMIN_ID не настроен.');
      return { data: null, error: adminId.error ?? 'TG_ADMIN_ID is not configured' };
    }
    try {
      const sent = await this.bot.api.sendMessage(adminId.data, buildUnreadNotificationText(record), {
        parse_mode: 'HTML',
        reply_markup: buildUnreadInitialKeyboard(record.negotiationId, record.chatUrl),
        link_preview_options: { is_disabled: true },
      });
      return { data: sent.message_id, error: null };
    } catch (err) {
      logger.error('Ошибка отправки уведомления о непрочитанном сообщении в Telegram', err);
      return { data: null, error: formatErrorDetails(err) || 'Failed to send unread chat notification' };
    }
  }

  public async sendCaptchaAlert(
    snapshot: CaptchaChallengeSnapshot
  ): Promise<SafeResult<boolean>> {
    const adminId = this.configStore.get('TG_ADMIN_ID');
    if (adminId.error || !adminId.data) {
      logger.warn('Не удалось отправить предупреждение о капче: TG_ADMIN_ID не настроен.');
      return { data: null, error: adminId.error ?? 'TG_ADMIN_ID is not configured' };
    }
    return sendCaptchaAlertToAdmin(this.bot, adminId.data, snapshot);
  }

  public countTodayApplications(): number {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startIso = startOfToday.toISOString();

    const rows = this.db
      .select({ id: applicationRecords.id })
      .from(applicationRecords)
      .where(
        and(
          gte(applicationRecords.appliedAt, startIso),
          notInArray(applicationRecords.status, ['pending_approval', 'skipped_user', 'skipped_low_score'])
        )
      )
      .limit(1000)
      .all();

    return rows.length;
  }

  public buildMainMenuKeyboard(): InlineKeyboard {
    const isEnabled = this.configStore.get('AUTO_APPLY_ENABLED').data === 'true';
    const isLogged = this.configStore.get('HH_IS_LOGGED_IN').data === 'true';
    const limit = this.configStore.getDailyLimit().data ?? 50;
    const todayCount = this.countTodayApplications();

    const kb = new InlineKeyboard()
      .text(isEnabled ? '⏸ Остановить автоотклики' : '▶️ Запустить автоотклики', 'menu:toggle_auto_apply').row()
      .text(`🎯 Лимит откликов в день (${todayCount}/${limit}, макс 100)`, 'menu:set_daily_limit').row()
      .text('⚙️ Настройки автоматизации', 'menu:automation_settings').row()
      .text('🚫 Черный список компаний', 'menu:blacklist').row();

    if (isLogged) {
      kb.text('🔑 Войти в HH.ru (Переподключить)', 'menu:login_hh')
        .text('🔄 Проверить сессию HH.ru', 'menu:confirm_login').row();
    } else {
      kb.text('🔑 Войти в HH.ru', 'menu:login_hh')
        .text('✅ Я вошел (Проверить вход)', 'menu:confirm_login').row();
    }

    return kb
      .text('📄 Загрузить резюме (PDF / Текст)', 'menu:upload_resume').row()
      .text('🔍 Настроить фильтры поиска', 'menu:setup_filters').row()
      .text('🧠 Управление моделью LLM', 'menu:llm_status').row()
      .text('📊 Статус', 'menu:status').row()
      .text('📊 Скачать отчет (Excel)', 'menu:export_excel').row()
      .text('🔄 Обновить статус меню', 'menu:refresh_main');
  }

  public buildMainMenuText(): string {
    const isAuto = this.configStore.get('AUTO_APPLY_ENABLED').data === 'true';
    const isLogged = this.configStore.get('HH_IS_LOGGED_IN').data === 'true';
    const limit = this.configStore.getDailyLimit().data ?? 50;
    const profile = this.getCurrentProfile();
    const filter = this.getCurrentFilter();
    const model = this.configStore.get('LLM_MODEL_NAME').data ?? 'не выбрана';
    const gamingMode =
      typeof this.configStore.getGamingMode === 'function'
        ? (this.configStore.getGamingMode().data ?? 'auto')
        : (this.configStore.get('GAMING_MODE').data ?? 'auto');
    const gamingModeLabel =
      gamingMode === 'on'
        ? '🎮 ВКЛ (Qwen 2.5 3B NPU)'
        : gamingMode === 'off'
          ? '🚀 ВЫКЛ (Только GPU)'
          : '⚡ Авто (GPU / NPU)';
    const mode = this.configStore.getApprovalMode().data ?? 'auto';
    const minScore = this.configStore.getMinMatchScore().data ?? 70;
    const autoBump = this.configStore.isAutoBumpResumeEnabled().data ?? true;
    const answerQ = this.configStore.isAnswerQuestionsEnabled().data ?? true;
    const skipForeign = this.configStore.isSkipForeignVacanciesEnabled?.().data ?? true;

    return [
      '🤖 <b>Панель управления HH.ru Auto-Responder</b>',
      '',
      `<b>Автоотклик:</b> ${isAuto ? '🟢 Активен' : '⏸ Остановлен'}`,
      `<b>Сессия HH.ru:</b> ${isLogged ? '🟢 Авторизована' : '🔴 Не выполнен вход'}`,
      `<b>Модель LLM (GPU):</b> <code>${escapeHtml(model)}</code>`,
      `<b>Игровой режим (NPU):</b> ${gamingModeLabel}`,
      `<b>Откликов за сегодня:</b> ${this.countTodayApplications()} из ${limit} (макс. 100/сутки)`,
      `<b>Режим одобрения:</b> ${mode === 'manual' ? '🖐 Ручной (Telegram)' : '⚡ Автоматический'}`,
      `<b>Мин. порог ИИ:</b> ${minScore}/100`,
      `<b>Автоподнятие резюме:</b> ${autoBump ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`,
      `<b>Автоответы на анкеты:</b> ${answerQ ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`,
      `<b>Пропуск вакансий за рубежом:</b> ${skipForeign ? '🟢 ВКЛ' : '⚪ ВЫКЛ'}`,
      `<b>Резюме:</b> ${profile ? escapeHtml(profile.hhResumeTitle) : 'Не загружено'}`,
      `<b>Поисковый фильтр:</b> ${filter ? escapeHtml(filter.queryText) : 'Не настроен'}`,
    ].join('\n');
  }

  public buildAutomationSettingsText(): string {
    return buildAutomationSettingsText(this.configStore);
  }

  public buildAutomationSettingsKeyboard(): InlineKeyboard {
    return buildAutomationSettingsKeyboard(this.configStore);
  }

  public async buildLlmStatusText(): Promise<string> {
    return buildLlmStatusText(this.llm);
  }

  public buildLlmStatusKeyboard(): InlineKeyboard {
    return buildLlmStatusKeyboard(this.configStore);
  }

  public async buildModelPickerKeyboard(): Promise<{ text: string; keyboard: InlineKeyboard }> {
    return buildModelPickerKeyboard(this.llm, this.configStore);
  }

  private registerApiTransformer(): void {
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      try {
        return await prev(method, payload, signal);
      } catch (err) {
        if (this.isStopping && method === 'getUpdates') return { ok: true, result: [] as never };
        if (signal?.aborted && method === 'getUpdates') throw err;
        const errorDetails = formatErrorDetails(err);
        const isTransientReset =
          method === 'getUpdates' &&
          (errorDetails.includes('ECONNRESET') || errorDetails.includes('socket hang up') || errorDetails.includes('ETIMEDOUT'));
        if (isTransientReset) {
          logger.warn(`Временный разрыв соединения long-polling [getUpdates] (${errorDetails})`);
          throw err;
        }
        logger.error(`Сбой сетевого запроса к Telegram API [${method}]`, err);
        throw err;
      }
    });
  }

  private async safeEditMessageText(
    ctx: Context,
    text: string,
    other?: Parameters<Context['editMessageText']>[1]
  ): Promise<void> {
    try {
      await ctx.editMessageText(text, other);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('message is not modified')) return;
      throw err;
    }
  }

  private registerMiddlewaresAndHandlers(): void {
    this.bot.catch((botErr) => {
      logger.error(`Ошибка в обработчике Telegram-бота (update_id=${botErr.ctx?.update?.update_id ?? 'unknown'})`, botErr.error);
    });

    this.bot.use(async (ctx, next) => {
      const adminIdResult = this.configStore.get('TG_ADMIN_ID');
      if (adminIdResult.error || !adminIdResult.data) return;
      const senderId = ctx.from?.id ? String(ctx.from.id) : '';
      if (senderId !== adminIdResult.data) {
        logger.warn(`Игнорирован запрос от неизвестного пользователя Telegram (ID: ${senderId || 'unknown'})`);
        return;
      }
      if (ctx.message?.text) {
        logger.info(`Входящее сообщение от администратора: "${ctx.message.text.slice(0, 60)}"`);
      } else if (ctx.callbackQuery?.data) {
        logger.info(`Нажата кнопка меню: [${ctx.callbackQuery.data}]`);
      } else if (ctx.message?.document) {
        logger.info(`Получен документ от администратора: "${ctx.message.document.file_name ?? 'unnamed'}"`);
      }
      await next();
    });

    this.bot.use(conversations());

    const wizardDeps: WizardDeps = {
      bot: this.bot,
      configStore: this.configStore,
      db: this.db,
      buildMainMenuText: () => this.buildMainMenuText(),
      buildMainMenuKeyboard: () => this.buildMainMenuKeyboard(),
      buildLlmStatusText: () => this.buildLlmStatusText(),
      buildLlmStatusKeyboard: () => this.buildLlmStatusKeyboard(),
      buildAutomationSettingsText: () => this.buildAutomationSettingsText(),
      buildAutomationSettingsKeyboard: () => this.buildAutomationSettingsKeyboard(),
      onDailyLimitUpdated: this.onDailyLimitUpdated,
    };

    registerWizardConversations(this.bot, wizardDeps);

    const editMain = async (ctx: Context) => {
      await this.safeEditMessageText(ctx, this.buildMainMenuText(), {
        parse_mode: 'HTML',
        reply_markup: this.buildMainMenuKeyboard(),
      });
    };

    const editSettings = async (ctx: Context) => {
      await this.safeEditMessageText(ctx, this.buildAutomationSettingsText(), {
        parse_mode: 'HTML',
        reply_markup: this.buildAutomationSettingsKeyboard(),
      });
    };

    const editLlm = async (ctx: Context) => {
      await this.safeEditMessageText(ctx, await this.buildLlmStatusText(), {
        parse_mode: 'HTML',
        reply_markup: this.buildLlmStatusKeyboard(),
      });
    };

    this.bot.command('start', async (ctx) => {
      if (this.configStore.get('HH_IS_LOGGED_IN').data !== 'true') {
        await this.handleInteractiveLogin(ctx);
        return;
      }
      await ctx.reply(this.buildMainMenuText(), { parse_mode: 'HTML', reply_markup: this.buildMainMenuKeyboard() });
    });

    this.bot.command('menu', async (ctx) => {
      await ctx.reply(this.buildMainMenuText(), { parse_mode: 'HTML', reply_markup: this.buildMainMenuKeyboard() });
    });

    this.bot.command('settings', async (ctx) => {
      await ctx.reply(this.buildAutomationSettingsText(), { parse_mode: 'HTML', reply_markup: this.buildAutomationSettingsKeyboard() });
    });

    this.bot.command('blacklist', async (ctx) => {
      await ctx.reply(buildBlacklistText(this.configStore), { parse_mode: 'HTML', reply_markup: buildBlacklistKeyboard(this.configStore) });
    });

    this.bot.command('filters', async (ctx) => {
      await ctx.conversation.enter('searchFiltersWizard');
    });

    this.bot.command('resume', async (ctx) => {
      await ctx.conversation.enter('uploadResumeWizard');
    });

    this.bot.command('limit', async (ctx) => {
      await ctx.conversation.enter('dailyLimitWizard');
    });

    this.bot.command('llm', async (ctx) => {
      await ctx.reply(await this.buildLlmStatusText(), { parse_mode: 'HTML', reply_markup: this.buildLlmStatusKeyboard() });
    });

    this.bot.command('logs', async (ctx) => {
      await ctx.reply(buildRecentErrorsReportText(agentLogger.readRecentErrors(5)), { parse_mode: 'HTML' });
    });

    this.bot.command('export', async (ctx) => {
      if (this.onExportRequested) {
        await this.onExportRequested(ctx);
        return;
      }
      await ctx.reply('📊 Модуль выгрузки Excel будет подключен на Фазе 5.');
    });

    const runCheckLogin = async (ctx: Context) => {
      if (!this.hhHybrid.confirmLogin) {
        await ctx.reply('⚠️ Проверка сессии не поддерживается текущим драйвером.');
        return;
      }
      const res = await this.hhHybrid.confirmLogin();
      if (res.error === 'CHECKING_IN_PROGRESS') {
        await ctx.reply('⏳ Проверяю авторизацию в открытом окне браузера...');
        return;
      }
      if (res.data) {
        await ctx.reply(
          `✅ Вход подтвержден! Сессия HH.ru активна.\nСчитано резюме: <b>${escapeHtml(res.data.hhResumeTitle)}</b>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply(
          `🔴 Авторизация в HH.ru не обнаружена: ${res.error ?? 'сессия не активна'}.\nПожалуйста, войдите в аккаунт через браузер.`
        );
      }
      await ctx.reply(this.buildMainMenuText(), {
        parse_mode: 'HTML',
        reply_markup: this.buildMainMenuKeyboard(),
      });
    };

    this.bot.command('check_login', async (ctx) => {
      await runCheckLogin(ctx);
    });

    this.bot.callbackQuery('menu:confirm_login', async (ctx) => {
      await ctx.answerCallbackQuery('Проверяю сессию HH.ru...');
      await runCheckLogin(ctx);
    });

    this.bot.callbackQuery('menu:login_hh', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.handleInteractiveLogin(ctx);
    });

    const runUnloadLlm = async (ctx: Context) => {
      await ctx.reply('⏳ Выгружаю модель LLM из оперативной памяти...');
      if (this.llm?.unloadModel) {
        const res = await this.llm.unloadModel();
        if (res.data) {
          await ctx.reply('🧹 Модель LLM успешно выгружена из памяти (keep_alive: 0). ОЗУ освобождено!');
        } else {
          await ctx.reply(`⚠️ Ошибка выгрузки модели: ${res.error ?? 'неизвестная ошибка'}`);
        }
      } else {
        await ctx.reply('⚠️ Метод выгрузки не поддерживается.');
      }
    };

    this.bot.command('unload_llm', async (ctx) => {
      await runUnloadLlm(ctx);
    });

    this.bot.callbackQuery('menu:unload_llm', async (ctx) => {
      await ctx.answerCallbackQuery('Выгружаю модель...');
      await runUnloadLlm(ctx);
    });

    const wizardTriggers: ReadonlyArray<readonly [string, string]> = [
      ['menu:upload_resume', 'uploadResumeWizard'],
      ['menu:setup_filters', 'searchFiltersWizard'],
      ['menu:set_daily_limit', 'dailyLimitWizard'],
      ['menu:llm_set_model_manual', 'llmModelManualWizard'],
      ['menu:llm_set_base_url', 'llmBaseUrlWizard'],
      ['settings:min_score', 'minMatchScoreWizard'],
    ];

    for (const [action, wizardId] of wizardTriggers) {
      this.bot.callbackQuery(action, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.conversation.enter(wizardId);
      });
    }

    this.bot.callbackQuery('menu:toggle_auto_apply', async (ctx) => {
      await ctx.answerCallbackQuery();
      const current = this.configStore.get('AUTO_APPLY_ENABLED').data === 'true';
      const nextState = !current;
      this.configStore.set('AUTO_APPLY_ENABLED', nextState ? 'true' : 'false');
      if (this.onAutoApplyToggled) {
        await this.onAutoApplyToggled(nextState);
      }
      await editMain(ctx);
    });

    this.bot.callbackQuery('menu:refresh_main', async (ctx) => {
      await ctx.answerCallbackQuery('Меню обновлено');
      await editMain(ctx);
    });

    this.bot.callbackQuery('menu:automation_settings', async (ctx) => {
      await ctx.answerCallbackQuery();
      await editSettings(ctx);
    });

    this.bot.callbackQuery('settings:toggle_approval_mode', async (ctx) => {
      await ctx.answerCallbackQuery();
      const current = this.configStore.getApprovalMode().data ?? 'auto';
      this.configStore.setApprovalMode(current === 'auto' ? 'manual' : 'auto');
      await editSettings(ctx);
    });

    this.bot.callbackQuery('settings:toggle_auto_bump', async (ctx) => {
      await ctx.answerCallbackQuery();
      const current = this.configStore.isAutoBumpResumeEnabled().data ?? true;
      this.configStore.setAutoBumpResumeEnabled(!current);
      await editSettings(ctx);
    });

    this.bot.callbackQuery('settings:toggle_answer_questions', async (ctx) => {
      await ctx.answerCallbackQuery();
      const current = this.configStore.isAnswerQuestionsEnabled().data ?? true;
      this.configStore.setAnswerQuestionsEnabled(!current);
      await editSettings(ctx);
    });

    this.bot.callbackQuery('settings:toggle_skip_foreign', async (ctx) => {
      await ctx.answerCallbackQuery();
      const current = this.configStore.isSkipForeignVacanciesEnabled?.().data ?? true;
      this.configStore.setSkipForeignVacanciesEnabled?.(!current);
      await editSettings(ctx);
    });

    this.bot.callbackQuery('menu:llm_status', async (ctx) => {
      await ctx.answerCallbackQuery();
      await editLlm(ctx);
    });

    this.bot.callbackQuery('menu:llm_refresh', async (ctx) => {
      await ctx.answerCallbackQuery('Статус LLM обновлен');
      await editLlm(ctx);
    });

    this.bot.callbackQuery('menu:llm_toggle_gaming_mode', async (ctx) => {
      let nextMode = 'auto';
      if (this.gamingModeService) {
        const cycled = this.gamingModeService.cycleGamingMode();
        nextMode = cycled.data ?? 'auto';
      } else {
        const current =
          typeof this.configStore.getGamingMode === 'function'
            ? (this.configStore.getGamingMode().data ?? 'auto')
            : (this.configStore.get('GAMING_MODE').data ?? 'auto');
        nextMode = current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto';
        if (typeof this.configStore.setGamingMode === 'function') {
          this.configStore.setGamingMode(nextMode as 'auto' | 'on' | 'off');
        } else {
          this.configStore.set('GAMING_MODE', nextMode);
        }
      }
      await ctx.answerCallbackQuery(`Игровой режим: ${nextMode.toUpperCase()}`);
      await editLlm(ctx);
    });

    this.bot.callbackQuery('menu:llm_select_installed', async (ctx) => {
      await ctx.answerCallbackQuery();
      const picker = await this.buildModelPickerKeyboard();
      await this.safeEditMessageText(ctx, picker.text, {
        parse_mode: 'HTML',
        reply_markup: picker.keyboard,
      });
    });

    this.bot.callbackQuery(/^menu:llm_pick:(\d+)$/, async (ctx) => {
      const match = ctx.match as RegExpMatchArray;
      const index = Number.parseInt(match[1] ?? '-1', 10);
      const listRes = await this.llm.listAvailableModels();
      if (listRes.error || !listRes.data || !listRes.data[index]) {
        await ctx.answerCallbackQuery('Ошибка: модель не найдена в списке');
        await editLlm(ctx);
        return;
      }
      const selected = listRes.data[index]!;
      this.configStore.set('LLM_MODEL_NAME', selected.name);
      await ctx.answerCallbackQuery(`Выбрана модель: ${selected.name}`);
      await editLlm(ctx);
    });

    this.bot.callbackQuery('menu:back_to_main', async (ctx) => {
      await ctx.answerCallbackQuery();
      await editMain(ctx);
    });

    this.bot.callbackQuery('menu:export_excel', async (ctx) => {
      await ctx.answerCallbackQuery();
      if (this.onExportRequested) {
        await this.onExportRequested(ctx);
        return;
      }
      await ctx.reply('📊 Модуль выгрузки Excel будет подключен на Фазе 5.');
    });

    registerBlacklistHandlers(this.bot, this.configStore, this.safeEditMessageText.bind(this));

    const approvalDeps: ApprovalHandlerDeps = {
      countTodayApplications: () => this.countTodayApplications(),
      configStore: this.configStore,
      db: this.db,
      hhHybrid: this.hhHybrid,
      llm: this.llm,
    };
    registerApprovalHandlers(this.bot, approvalDeps, this.safeEditMessageText.bind(this));

    registerMessagingHandlers(this.bot, {
      db: this.db,
      hhMessaging: this.hhMessaging,
      llmReply: this.llmReply,
      safeEditMessageText: this.safeEditMessageText.bind(this),
    });

    registerStatusHandlers(this.bot, {
      db: this.db,
      configStore: this.configStore,
      captchaService: this.captchaService,
      safeEditMessageText: this.safeEditMessageText.bind(this),
    });

    if (this.captchaService) {
      registerCaptchaHandlers(this.bot, this.captchaService);
    }
  }

  private async handleInteractiveLogin(ctx: Context): Promise<void> {
    const loginKeyboard = new InlineKeyboard().text('✅ Я вошел (Проверить вход)', 'menu:confirm_login');
    await ctx.reply(
      '🖥 Открываю окно браузера Chromium на ПК (страница https://hh.ru/account/login).\n' +
      'Пожалуйста, войдите в свой аккаунт HH.ru (по СМС или паролю).\n\n' +
      'После входа нажмите кнопку ниже или просто закройте окно браузера:',
      { reply_markup: loginKeyboard }
    );
    const loginResult = await this.hhHybrid.loginInteractive();
    if (loginResult.error || !loginResult.data) {
      await ctx.reply(`❌ Статус входа в HH.ru: ${loginResult.error ?? 'не удалось завершить авторизацию'}`);
    } else {
      await ctx.reply(
        `✅ Вход выполнен успешно!\nСчитано резюме: <b>${escapeHtml(loginResult.data.hhResumeTitle)}</b>`,
        { parse_mode: 'HTML' }
      );
    }
    await ctx.reply(this.buildMainMenuText(), {
      parse_mode: 'HTML',
      reply_markup: this.buildMainMenuKeyboard(),
    });
  }

  private getCurrentProfile(): UserProfile | null {
    return this.db.select().from(userProfiles).limit(1).get() ?? null;
  }

  private getCurrentFilter(): SearchFilter | null {
    return this.db.select().from(searchFilters).limit(1).get() ?? null;
  }
}
