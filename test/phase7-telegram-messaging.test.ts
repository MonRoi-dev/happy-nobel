import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { Context } from 'grammy';
import {
  negotiationMessages,
  userProfiles,
  type NegotiationMessageRecord,
} from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/index.ts';
import type {
  ChatMessageBubble,
  IHhHybridService,
  IHhMessagingService,
  UnreadNegotiationItem,
} from '../src/modules/hh-hybrid/index.ts';
import type {
  GenerateEmployerReplyInput,
  ILlmReplyService,
  ILlmService,
  LlmChatReply,
} from '../src/modules/llm/index.ts';
import type { AgentLogEntry } from '../src/modules/logger/index.ts';
import { SchedulerService } from '../src/modules/scheduler/index.ts';
import {
  BOT_MENU_COMMANDS,
  buildRecentErrorsReportText,
  buildUnreadDraftKeyboard,
  buildUnreadDraftPreviewText,
  buildUnreadInitialKeyboard,
  buildUnreadNotificationText,
  buildUnreadSentKeyboard,
  buildUnreadSentText,
  handleAiReplyCallback,
  registerMessagingHandlers,
  syncUnreadMessagesCore,
  TelegramBotService,
  type ITelegramBotService,
  type MessagingHandlerDeps,
} from '../src/modules/telegram/index.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
    CREATE TABLE "company_blacklist" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "companyName" TEXT NOT NULL UNIQUE, "addedAt" TEXT NOT NULL);
    CREATE TABLE "user_profile" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "hhResumeTitle" TEXT NOT NULL, "resumeRawText" TEXT NOT NULL, "customPromptRules" TEXT);
    CREATE TABLE "search_filters" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "queryText" TEXT NOT NULL, "excludedWords" TEXT, "areaId" TEXT, "schedule" TEXT, "salaryFrom" INTEGER);
    CREATE TABLE "application_records" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "vacancyId" TEXT NOT NULL UNIQUE, "companyName" TEXT NOT NULL, "positionTitle" TEXT NOT NULL, "salaryText" TEXT NOT NULL, "vacancyUrl" TEXT NOT NULL, "coverLetter" TEXT NOT NULL, "status" TEXT NOT NULL, "matchScore" INTEGER, "aiReasoning" TEXT, "lastEmployerMessage" TEXT, "isNotified" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
    CREATE TABLE "negotiation_messages" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "negotiation_id" TEXT NOT NULL UNIQUE, "vacancy_id" TEXT NOT NULL, "company_name" TEXT NOT NULL, "position_title" TEXT NOT NULL, "chat_url" TEXT NOT NULL, "last_unread_text" TEXT NOT NULL, "chat_history_json" TEXT NOT NULL, "extracted_contacts" TEXT, "telegram_message_id" INTEGER, "reply_status" TEXT NOT NULL DEFAULT 'unread_notified', "ai_generated_reply" TEXT, "updated_at" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function createDummyLlm(): ILlmService {
  return {
    generateCoverLetter: async () => ({ data: { coverLetter: 'Letter' }, error: null }),
    evaluateVacancy: async () => ({ data: { matchScore: 90, fitsProfile: true, reasoning: 'Fit', keySkills: [] }, error: null }),
    answerEmployerQuestions: async () => ({ data: [], error: null }),
    checkHealth: async () => ({ data: { model: 'gemma4:64k', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline: true,
        baseUrl: 'http://127.0.0.1:11434',
        configuredModel: 'gemma4:64k',
        isConfiguredModelInstalled: true,
        isConfiguredModelLoaded: true,
        pingMs: 5,
        installedModels: [],
        activeModels: [],
        error: null,
      },
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
  };
}

function createDummyHhHybrid(overrides: Partial<IHhHybridService> = {}): IHhHybridService {
  return {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({ data: { items: [], found: 0, pages: 0, page: 0, perPage: 20 }, error: null }),
    getVacancyDetails: async () => ({ data: null, error: 'Not implemented' }),
    applyToVacancy: async () => ({ data: true, error: null }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'bumped', error: null }),
    ...overrides,
  };
}

function createMockContext() {
  const answeredQueries: Array<{ text?: string; showAlert?: boolean }> = [];
  const repliedTexts: string[] = [];

  const ctx = {
    answerCallbackQuery: async (opts?: unknown) => {
      if (typeof opts === 'string') {
        answeredQueries.push({ text: opts, showAlert: false });
      } else if (opts && typeof opts === 'object') {
        const obj = opts as { text?: string; show_alert?: boolean };
        answeredQueries.push({ text: obj.text, showAlert: obj.show_alert });
      } else {
        answeredQueries.push({});
      }
    },
    reply: async (text: string) => {
      repliedTexts.push(text);
      return { message_id: 999 };
    },
  } as unknown as Context;

  return { ctx, answeredQueries, repliedTexts };
}

test('buildUnreadNotificationText formats company, position and message with HTML escaping', () => {
  const text = buildUnreadNotificationText({
    companyName: 'Yandex & Google <Tech>',
    positionTitle: 'Senior "Node.js" Dev',
    lastUnreadText: 'Здравствуйте! Уточните ваш стек <Node/TS>?',
  });

  assert.ok(text.includes('Новое сообщение от работодателя!'));
  assert.ok(text.includes('Yandex &amp; Google &lt;Tech&gt;'));
  assert.ok(text.includes('Senior &quot;Node.js&quot; Dev'));
  assert.ok(text.includes('&lt;Node/TS&gt;?'));
});

test('buildUnreadInitialKeyboard creates direct link and AI generate buttons', () => {
  const keyboard = buildUnreadInitialKeyboard('neg-100', 'https://hh.ru/chat/100');
  const flat = keyboard.inline_keyboard.flat();

  assert.equal(flat.length, 2);
  assert.equal(flat[0]?.text, '🔗 Ответить самостоятельно');
  assert.equal(flat[0]?.url, 'https://hh.ru/chat/100');
  assert.equal(flat[1]?.text, '🤖 Сгенерировать ИИ');
  assert.equal(flat[1]?.callback_data, 'ai_reply:gen:neg-100');
});

test('buildUnreadDraftPreviewText and buildUnreadDraftKeyboard format draft and action buttons', () => {
  const preview = buildUnreadDraftPreviewText(
    {
      companyName: 'Acme Corp',
      positionTitle: 'Backend Dev',
      lastUnreadText: 'Когда готовы начать?',
    },
    'Готов выйти в понедельник.'
  );

  assert.ok(preview.includes('Черновик ответа ИИ:'));
  assert.ok(preview.includes('<pre>Готов выйти в понедельник.</pre>'));

  const keyboard = buildUnreadDraftKeyboard('neg-200', 'https://hh.ru/chat/200');
  const rows = keyboard.inline_keyboard;

  assert.equal(rows.length, 2);
  assert.equal(rows[0]![0]?.text, '📤 Отправить');
  assert.equal(rows[0]![0]?.callback_data, 'ai_reply:send:neg-200');
  assert.equal(rows[0]![1]?.text, '🔄 Перегенерировать');
  assert.equal(rows[0]![1]?.callback_data, 'ai_reply:regen:neg-200');
  assert.equal(rows[1]![0]?.text, '🔗 Ответить самостоятельно');
  assert.equal(rows[1]![0]?.url, 'https://hh.ru/chat/200');
});

test('buildUnreadSentText and buildUnreadSentKeyboard format sent confirmation and done state', () => {
  const sentText = buildUnreadSentText(
    {
      companyName: 'Beta LLC',
      positionTitle: 'Lead Architect',
      lastUnreadText: 'Пришлите пример кода',
    },
    'Вот ссылка на GitHub репозиторий.'
  );

  assert.ok(sentText.includes('Ответ ИИ отправлен:'));
  assert.ok(sentText.includes('<pre>Вот ссылка на GitHub репозиторий.</pre>'));

  const keyboard = buildUnreadSentKeyboard('neg-300', 'https://hh.ru/chat/300');
  const rows = keyboard.inline_keyboard;

  assert.equal(rows.length, 2);
  assert.equal(rows[0]![0]?.text, '🔗 Ответить самостоятельно');
  assert.equal(rows[0]![0]?.url, 'https://hh.ru/chat/300');
  assert.equal(rows[1]![0]?.text, '✅ Ответ ИИ отправлен');
  assert.equal(rows[1]![0]?.callback_data, 'ai_reply:done:neg-300');
});

test('buildRecentErrorsReportText formats empty and non-empty log entries up to 5', () => {
  const emptyReport = buildRecentErrorsReportText([]);
  assert.equal(emptyReport, '✅ <b>Ошибок в agent-errors.jsonl не зафиксировано.</b>');

  const entries: AgentLogEntry[] = [
    {
      timestamp: '2026-10-21T20:00:00.000Z',
      level: 'ERROR',
      traceId: 'tr-1',
      module: 'HH_MESSAGING',
      action: 'SEND_CHAT_MESSAGE',
      message: 'Failed to find textarea selector',
      error: {
        name: 'TimeoutError',
        message: 'Timeout 5000ms',
        DiagnosticHintForAgent: 'Verify HH chat textarea selector on new DOM structure',
      },
    },
    {
      timestamp: '2026-10-21T20:05:00.000Z',
      level: 'ERROR',
      traceId: 'tr-2',
      module: 'LLM_SERVICE',
      action: 'GENERATE_EMPLOYER_REPLY',
      message: 'HTTP 500 Ollama crash',
    },
  ];

  const report = buildRecentErrorsReportText(entries);
  assert.ok(report.includes('Последние ошибки (2)'));
  assert.ok(report.includes('[HH_MESSAGING] SEND_CHAT_MESSAGE'));
  assert.ok(report.includes('Failed to find textarea selector'));
  assert.ok(report.includes('Verify HH chat textarea selector on new DOM structure'));
  assert.ok(report.includes('[LLM_SERVICE] GENERATE_EMPLOYER_REPLY'));
});

test('syncUnreadMessagesCore inserts records, notifies Telegram, and prevents duplicate alerts', async () => {
  const { db } = createTestDatabase();
  const unreadItems: UnreadNegotiationItem[] = [
    {
      negotiationId: 'neg-101',
      vacancyId: 'vac-1',
      companyName: 'GoodCorp',
      positionTitle: 'Backend Dev',
      chatUrl: 'https://hh.ru/chat/neg-101',
      unreadMessages: ['Добрый день! Вы готовы к техническому интервью?'],
      fullHistory: [
        { sender: 'employer', text: 'Добрый день! Вы готовы к техническому интервью?' },
      ],
    },
  ];

  const mockHhMessaging: IHhMessagingService = {
    fetchUnreadNegotiations: async () => ({ data: unreadItems, error: null }),
    sendChatMessage: async () => ({ data: true, error: null }),
  };

  const notifiedRecords: NegotiationMessageRecord[] = [];
  const sendUnreadChatNotification = async (record: NegotiationMessageRecord) => {
    notifiedRecords.push(record);
    return { data: 777, error: null };
  };

  const sync1 = await syncUnreadMessagesCore({
    db,
    hhMessaging: mockHhMessaging,
    sendUnreadChatNotification,
  });

  assert.equal(sync1.error, null);
  assert.equal(sync1.data?.checkedCount, 1);
  assert.equal(sync1.data?.notifiedCount, 1);
  assert.equal(notifiedRecords.length, 1);
  assert.equal(notifiedRecords[0]?.negotiationId, 'neg-101');

  const row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.replyStatus, 'unread_notified');
  assert.equal(row?.telegramMessageId, 777);
  assert.equal(row?.lastUnreadText, 'Добрый день! Вы готовы к техническому интервью?');

  const sync2 = await syncUnreadMessagesCore({
    db,
    hhMessaging: mockHhMessaging,
    sendUnreadChatNotification,
  });

  assert.equal(sync2.error, null);
  assert.equal(sync2.data?.checkedCount, 1);
  assert.equal(sync2.data?.notifiedCount, 0);
  assert.equal(notifiedRecords.length, 1);

  const updatedUnreadItems: UnreadNegotiationItem[] = [
    {
      negotiationId: 'neg-101',
      vacancyId: 'vac-1',
      companyName: 'GoodCorp',
      positionTitle: 'Backend Dev',
      chatUrl: 'https://hh.ru/chat/neg-101',
      unreadMessages: ['Повторный вопрос: когда вам удобно?'],
      fullHistory: [
        { sender: 'employer', text: 'Добрый день! Вы готовы к техническому интервью?' },
        { sender: 'employer', text: 'Повторный вопрос: когда вам удобно?' },
      ],
    },
  ];

  const mockHhMessagingUpdated: IHhMessagingService = {
    fetchUnreadNegotiations: async () => ({ data: updatedUnreadItems, error: null }),
    sendChatMessage: async () => ({ data: true, error: null }),
  };

  const sync3 = await syncUnreadMessagesCore({
    db,
    hhMessaging: mockHhMessagingUpdated,
    sendUnreadChatNotification,
  });

  assert.equal(sync3.error, null);
  assert.equal(sync3.data?.notifiedCount, 1);
  assert.equal(notifiedRecords.length, 2);

  const updatedRow = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(updatedRow?.lastUnreadText, 'Повторный вопрос: когда вам удобно?');
  assert.equal(updatedRow?.replyStatus, 'unread_notified');
});

test('handleAiReplyCallback handles done, gen with temperature 0.35, regen with 0.65, and send', async () => {
  const { db } = createTestDatabase();
  const nowIso = new Date().toISOString();

  db.insert(userProfiles).values({
    hhResumeTitle: 'Senior Node.js Developer',
    resumeRawText: 'Experienced in TypeScript, Postgres, and Docker',
    customPromptRules: 'Будь краток',
  }).run();

  db.insert(negotiationMessages).values({
    negotiationId: 'neg-201',
    vacancyId: 'vac-201',
    companyName: 'InnovateTech',
    positionTitle: 'Backend Architect',
    chatUrl: 'https://hh.ru/chat/neg-201',
    lastUnreadText: 'Какой у вас опыт с микросервисами?',
    chatHistoryJson: JSON.stringify([
      { sender: 'employer', text: 'Какой у вас опыт с микросервисами?' },
    ]),
    replyStatus: 'unread_notified',
    updatedAt: nowIso,
  }).run();

  let generatedInputs: GenerateEmployerReplyInput[] = [];
  const mockLlmReply: ILlmReplyService = {
    generateEmployerReply: async (input) => {
      generatedInputs.push(input);
      return {
        data: {
          replyText: `Ответ для ${input.companyName} с температурой ${input.temperature}: опыт более 5 лет.`,
          confidenceScore: 95,
          summaryOfIntent: 'Confirm experience',
        },
        error: null,
      };
    },
  };

  let sentChats: Array<{ negotiationId: string; replyText: string }> = [];
  const mockHhMessaging: IHhMessagingService = {
    fetchUnreadNegotiations: async () => ({ data: [], error: null }),
    sendChatMessage: async (negotiationId, replyText) => {
      sentChats.push({ negotiationId, replyText });
      return { data: true, error: null };
    },
  };

  let editedText = '';
  let editedMarkup: unknown = null;
  const safeEditMessageText = async (_ctx: Context, text: string, other?: unknown) => {
    editedText = text;
    editedMarkup = (other as { reply_markup?: unknown })?.reply_markup;
  };

  const deps: MessagingHandlerDeps = {
    db,
    hhMessaging: mockHhMessaging,
    llmReply: mockLlmReply,
    safeEditMessageText,
  };

  const { ctx: doneCtx, answeredQueries: doneQueries } = createMockContext();
  const doneRes = await handleAiReplyCallback('done', 'neg-201', deps, doneCtx);
  assert.equal(doneRes.error, null);
  assert.equal(doneQueries[0]?.text, 'Ответ уже отправлен');

  const { ctx: genCtx, answeredQueries: genQueries } = createMockContext();
  const genRes = await handleAiReplyCallback('gen', 'neg-201', deps, genCtx);
  assert.equal(genRes.error, null);
  assert.equal(genQueries[0]?.text, 'Генерирую черновик ответа через Gemma 4...');
  assert.equal(generatedInputs.length, 1);
  assert.equal(generatedInputs[0]?.temperature, 0.35);
  assert.equal(generatedInputs[0]?.companyName, 'InnovateTech');
  assert.ok(editedText.includes('Черновик ответа ИИ:'));
  assert.ok(editedText.includes('с температурой 0.35'));

  let row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.replyStatus, 'draft_generated');
  assert.ok(row?.aiGeneratedReply?.includes('с температурой 0.35'));

  const { ctx: regenCtx } = createMockContext();
  const regenRes = await handleAiReplyCallback('regen', 'neg-201', deps, regenCtx);
  assert.equal(regenRes.error, null);
  assert.equal(generatedInputs.length, 2);
  assert.equal(generatedInputs[1]?.temperature, 0.65);
  assert.ok(editedText.includes('с температурой 0.65'));

  const { ctx: sendCtx, answeredQueries: sendQueries } = createMockContext();
  const sendRes = await handleAiReplyCallback('send', 'neg-201', deps, sendCtx);
  assert.equal(sendRes.error, null);
  assert.equal(sendQueries[0]?.text, 'Отправляю ответ в чат HH.ru...');
  assert.equal(sentChats.length, 1);
  assert.equal(sentChats[0]?.negotiationId, 'neg-201');
  assert.ok(sentChats[0]?.replyText.includes('с температурой 0.65'));
  assert.ok(editedText.includes('Ответ ИИ отправлен:'));

  row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.replyStatus, 'replied_by_ai');

  const { ctx: repeatSendCtx, answeredQueries: repeatQueries } = createMockContext();
  const repeatRes = await handleAiReplyCallback('send', 'neg-201', deps, repeatSendCtx);
  assert.equal(repeatRes.error, null);
  assert.equal(repeatQueries[0]?.text, 'Ответ уже был отправлен');
  assert.equal(sentChats.length, 1);
});

test('handleAiReplyCallback send generates draft first if aiGeneratedReply is missing', async () => {
  const { db } = createTestDatabase();
  const nowIso = new Date().toISOString();

  db.insert(negotiationMessages).values({
    negotiationId: 'neg-direct-send',
    vacancyId: 'vac-99',
    companyName: 'DirectCorp',
    positionTitle: 'Developer',
    chatUrl: 'https://hh.ru/chat/direct',
    lastUnreadText: 'Когда перезвонить?',
    chatHistoryJson: '[]',
    replyStatus: 'unread_notified',
    aiGeneratedReply: null,
    updatedAt: nowIso,
  }).run();

  let sentText = '';
  const deps: MessagingHandlerDeps = {
    db,
    hhMessaging: {
      fetchUnreadNegotiations: async () => ({ data: [], error: null }),
      sendChatMessage: async (_id, text) => {
        sentText = text;
        return { data: true, error: null };
      },
    },
    llmReply: {
      generateEmployerReply: async () => ({
        data: {
          replyText: 'Удобно после 18:00 по МСК.',
          confidenceScore: 90,
          summaryOfIntent: 'Schedule call',
        },
        error: null,
      }),
    },
    safeEditMessageText: async () => {},
  };

  const { ctx } = createMockContext();
  const res = await handleAiReplyCallback('send', 'neg-direct-send', deps, ctx);
  assert.equal(res.error, null);
  assert.equal(sentText, 'Удобно после 18:00 по МСК.');

  const row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.replyStatus, 'replied_by_ai');
  assert.equal(row?.aiGeneratedReply, 'Удобно после 18:00 по МСК.');
});

test('handleAiReplyCallback updates status to failed when hhMessaging returns error', async () => {
  const { db } = createTestDatabase();
  const nowIso = new Date().toISOString();

  db.insert(negotiationMessages).values({
    negotiationId: 'neg-fail',
    vacancyId: 'vac-fail',
    companyName: 'FailCorp',
    positionTitle: 'Developer',
    chatUrl: 'https://hh.ru/chat/fail',
    lastUnreadText: 'Сообщение',
    chatHistoryJson: '[]',
    replyStatus: 'draft_generated',
    aiGeneratedReply: 'Текст ответа',
    updatedAt: nowIso,
  }).run();

  const { ctx, repliedTexts } = createMockContext();
  const deps: MessagingHandlerDeps = {
    db,
    hhMessaging: {
      fetchUnreadNegotiations: async () => ({ data: [], error: null }),
      sendChatMessage: async () => ({ data: null, error: 'Network timeout' }),
    },
    safeEditMessageText: async () => {},
  };

  const res = await handleAiReplyCallback('send', 'neg-fail', deps, ctx);
  assert.equal(res.data, null);
  assert.equal(res.error, 'Network timeout');
  assert.ok(repliedTexts[0]?.includes('Ошибка отправки ответа: Network timeout'));

  const row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.replyStatus, 'failed');
});

test('TelegramBotService sendUnreadChatNotification sends formatted alert with initial keyboard', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456789:ABCDEF12345678901234567890123456789', '987654321');

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm()
  );

  const apiCalls: Array<{ method: string; payload: unknown }> = [];
  botService.bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    return { ok: true, result: { message_id: 4242 } as never };
  });

  const record: NegotiationMessageRecord = {
    id: 1,
    negotiationId: 'neg-tg-test',
    vacancyId: 'vac-10',
    companyName: 'CloudCorp',
    positionTitle: 'DevOps',
    chatUrl: 'https://hh.ru/chat/neg-tg-test',
    lastUnreadText: 'Готовы ли вы к релокации?',
    chatHistoryJson: '[]',
    telegramMessageId: null,
    replyStatus: 'unread_notified',
    aiGeneratedReply: null,
    updatedAt: new Date().toISOString(),
  };

  const res = await botService.sendUnreadChatNotification(record);
  assert.equal(res.error, null);
  assert.equal(res.data, 4242);

  const sendCall = apiCalls.find((c) => c.method === 'sendMessage');
  assert.ok(sendCall);
  const payload = sendCall.payload as { chat_id: string; text: string; reply_markup: unknown };
  assert.equal(payload.chat_id, '987654321');
  assert.ok(payload.text.includes('CloudCorp'));
  assert.ok(payload.text.includes('Готовы ли вы к релокации?'));
});

test('SchedulerService runUnreadMessagesSync runs sync and records unread messages', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456789:ABCDEF12345678901234567890123456789', '987654321');

  const notifiedNegIds: string[] = [];
  const mockTelegram: ITelegramBotService = {
    bot: {} as never,
    start: async () => {},
    stop: async () => {},
    syncBotCommandMenu: async () => ({ data: true, error: null }),
    sendAdminMessage: async () => ({ data: true, error: null }),
    sendApprovalCard: async () => ({ data: true, error: null }),
    sendUnreadChatNotification: async (rec) => {
      notifiedNegIds.push(rec.negotiationId);
      return { data: 555, error: null };
    },
    buildMainMenuKeyboard: () => ({} as never),
    buildMainMenuText: () => '',
    buildAutomationSettingsKeyboard: () => ({} as never),
    buildAutomationSettingsText: () => '',
    buildLlmStatusKeyboard: () => ({} as never),
    buildLlmStatusText: async () => '',
    buildModelPickerKeyboard: async () => ({ text: '', keyboard: {} as never }),
    countTodayApplications: () => 0,
  };

  const mockHhMessaging: IHhMessagingService = {
    fetchUnreadNegotiations: async () => ({
      data: [
        {
          negotiationId: 'neg-sched-1',
          vacancyId: 'vac-1',
          companyName: 'SchedCorp',
          positionTitle: 'Developer',
          chatUrl: 'https://hh.ru/chat/sched-1',
          unreadMessages: ['Привет от планировщика!'],
          fullHistory: [{ sender: 'employer', text: 'Привет от планировщика!' }],
        },
      ],
      error: null,
    }),
    sendChatMessage: async () => ({ data: true, error: null }),
  };

  const scheduler = new SchedulerService(
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm(),
    mockTelegram,
    {
      hhMessaging: mockHhMessaging,
    }
  );

  const res = await scheduler.runUnreadMessagesSync();
  assert.equal(res.error, null);
  assert.equal(res.data?.checkedCount, 1);
  assert.equal(res.data?.notifiedCount, 1);
  assert.deepEqual(notifiedNegIds, ['neg-sched-1']);

  const row = db.select().from(negotiationMessages).limit(1).get();
  assert.equal(row?.negotiationId, 'neg-sched-1');
  assert.equal(row?.telegramMessageId, 555);
});
