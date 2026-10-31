import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { applicationRecords, userProfiles } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/index.ts';
import type { IHhHybridService } from '../src/modules/hh-hybrid/index.ts';
import type { ILlmService } from '../src/modules/llm/index.ts';
import {
  BOT_MENU_COMMANDS,
  buildApprovalCardKeyboard,
  buildApprovalCardText,
  buildBlacklistKeyboard,
  buildBlacklistText,
  handleApprovalAction,
  parseAndClampMinMatchScore,
  TelegramBotService,
  type ApprovalHandlerDeps,
} from '../src/modules/telegram/index.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
    CREATE TABLE "company_blacklist" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "companyName" TEXT NOT NULL UNIQUE, "addedAt" TEXT NOT NULL);
    CREATE TABLE "user_profile" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "hhResumeTitle" TEXT NOT NULL, "resumeRawText" TEXT NOT NULL, "customPromptRules" TEXT);
    CREATE TABLE "search_filters" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "queryText" TEXT NOT NULL, "excludedWords" TEXT, "areaId" TEXT, "schedule" TEXT, "salaryFrom" INTEGER);
    CREATE TABLE "application_records" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "vacancyId" TEXT NOT NULL UNIQUE, "companyName" TEXT NOT NULL, "positionTitle" TEXT NOT NULL, "salaryText" TEXT NOT NULL, "vacancyUrl" TEXT NOT NULL, "coverLetter" TEXT NOT NULL, "status" TEXT NOT NULL, "matchScore" INTEGER, "aiReasoning" TEXT, "lastEmployerMessage" TEXT, "isNotified" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function createDummyHhHybrid(overrides: Partial<IHhHybridService> = {}): IHhHybridService {
  return {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({ data: { items: [], found: 0, pages: 0, page: 0, perPage: 20 }, error: null }),
    getVacancyDetails: async (id = '100') => ({
      data: {
        vacancy: {
          id,
          name: 'Title',
          description: 'Detailed description of the vacancy requirement',
          alternate_url: `https://hh.ru/vacancy/${id}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'Company' },
          key_skills: [],
        },
        cleanDescription: 'Detailed description of the vacancy requirement',
        salaryText: '100 000 руб.',
        vacancyId: id,
        title: 'Title',
        companyName: 'Company',
        salary: '100000',
        employerQuestions: [],
        rawHtml: '',
      } as unknown as import('../src/modules/hh-hybrid/index.ts').ScrapedVacancyDetailsResult,
      error: null,
    }),
    applyToVacancy: async () => ({ data: true, error: null }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'bumped', error: null }),
    ...overrides,
  };
}

function createDummyLlm(overrides: Partial<ILlmService> = {}): ILlmService {
  return {
    generateCoverLetter: async () => ({ data: 'Сгенерированное письмо для теста', error: null }),
    evaluateVacancy: async () => ({ data: { matchScore: 90, reasoning: 'Отличный стек', coverLetter: 'Письмо' }, error: null }),
    answerEmployerQuestions: async () => ({ data: [], error: null }),
    checkHealth: async () => ({ data: { model: 'gemma4:64k', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline: true,
        pingMs: 15,
        configuredModel: 'gemma4:64k',
        isConfiguredModelInstalled: true,
        isConfiguredModelLoaded: true,
        installedModels: [],
        activeModels: [],
        baseUrl: 'http://127.0.0.1:11434',
        error: null,
      },
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
    ...overrides,
  };
}

test('telegram-blacklist - buildBlacklistText and buildBlacklistKeyboard for empty and non-empty list', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const emptyText = buildBlacklistText(configStore);
  assert.ok(emptyText.includes('Черный список работодателей'));
  assert.ok(emptyText.includes('Список пуст'));

  const emptyKb = buildBlacklistKeyboard(configStore);
  assert.ok(emptyKb.inline_keyboard.some((row) => row.some((btn) => btn.text.includes('Добавить компанию'))));
  assert.ok(emptyKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:back_to_main')));

  configStore.addBlacklistedCompany('VK');
  configStore.addBlacklistedCompany('Yandex');

  const populatedText = buildBlacklistText(configStore);
  assert.ok(populatedText.includes('1. vk'));
  assert.ok(populatedText.includes('2. yandex'));

  const populatedKb = buildBlacklistKeyboard(configStore);
  assert.ok(populatedKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'bl:del:1')));
  assert.ok(populatedKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'bl:del:2')));
});

test('parseAndClampMinMatchScore - parses 0..100 and rejects invalid inputs', () => {
  assert.deepEqual(parseAndClampMinMatchScore('0'), { data: 0, error: null });
  assert.deepEqual(parseAndClampMinMatchScore('75'), { data: 75, error: null });
  assert.deepEqual(parseAndClampMinMatchScore('100'), { data: 100, error: null });
  assert.deepEqual(parseAndClampMinMatchScore('  80  '), { data: 80, error: null });

  assert.equal(parseAndClampMinMatchScore('-1').data, null);
  assert.equal(parseAndClampMinMatchScore('101').data, null);
  assert.equal(parseAndClampMinMatchScore('abc').data, null);
  assert.equal(parseAndClampMinMatchScore('').data, null);
});

test('telegram-approval - buildApprovalCardText and buildApprovalCardKeyboard', () => {
  const record = {
    id: 42,
    vacancyId: '999',
    companyName: 'Acme Corp',
    positionTitle: 'Senior TypeScript Engineer',
    salaryText: '300 000 руб.',
    vacancyUrl: 'https://hh.ru/vacancy/999',
    coverLetter: 'Здравствуйте! Я опытный инженер.',
    status: 'pending_approval',
    matchScore: 92,
    aiReasoning: 'Стек идеально совпадает с опытом кандидата',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
  };

  const cardText = buildApprovalCardText(record);
  assert.ok(cardText.includes('Senior TypeScript Engineer'));
  assert.ok(cardText.includes('Acme Corp'));
  assert.ok(cardText.includes('300 000 руб.'));
  assert.ok(cardText.includes('92/100'));
  assert.ok(cardText.includes('Стек идеально совпадает'));
  assert.ok(cardText.includes('Здравствуйте! Я опытный инженер.'));

  const cardKb = buildApprovalCardKeyboard(record.id);
  assert.ok(cardKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'appr:send:42')));
  assert.ok(cardKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'appr:regen:42')));
  assert.ok(cardKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'appr:skip:42')));
  assert.ok(cardKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'appr:bl:42')));
});

test('handleApprovalAction - send action respects daily limit and submits application', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.setDailyLimit(2);

  db.insert(userProfiles).values({
    hhResumeTitle: 'Frontend Lead',
    resumeRawText: 'Vue React Node.js',
    customPromptRules: null,
  }).run();

  db.insert(applicationRecords).values({
    id: 1,
    vacancyId: 'vac-1',
    companyName: 'StarCorp',
    positionTitle: 'Lead Dev',
    salaryText: '400 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-1',
    coverLetter: 'Original cover letter',
    status: 'pending_approval',
    matchScore: 85,
    aiReasoning: 'Great match',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  let applyCalledWith: unknown = null;
  const hhHybrid = createDummyHhHybrid({
    applyToVacancy: async (input) => {
      applyCalledWith = input;
      return { data: true, error: null };
    },
  });

  const deps: ApprovalHandlerDeps = {
    countTodayApplications: () => 2,
    configStore,
    db,
    hhHybrid,
    llm: createDummyLlm(),
  };

  const limitBlocked = await handleApprovalAction('send', 1, deps);
  assert.equal(limitBlocked.data, null);
  assert.ok(limitBlocked.error?.includes('исчерпан'));

  const allowedDeps: ApprovalHandlerDeps = {
    ...deps,
    countTodayApplications: () => 1,
  };

  const successRes = await handleApprovalAction('send', 1, allowedDeps);
  assert.equal(successRes.error, null);
  assert.ok(successRes.data?.updatedText.includes('успешно отправлен'));
  assert.ok(applyCalledWith);

  const updatedRow = db.select().from(applicationRecords).limit(1).get();
  assert.equal(updatedRow?.status, 'response');
  assert.equal(updatedRow?.isNotified, true);
});

test('handleApprovalAction - send action handles QUESTIONS_REQUIRED', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  db.insert(applicationRecords).values({
    id: 2,
    vacancyId: 'vac-2',
    companyName: 'TestCorp',
    positionTitle: 'Backend Dev',
    salaryText: '200 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-2',
    coverLetter: 'Cover letter',
    status: 'pending_approval',
    matchScore: 80,
    aiReasoning: 'Match',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  const hhHybrid = createDummyHhHybrid({
    applyToVacancy: async () => ({ data: null, error: 'QUESTIONS_REQUIRED' }),
  });

  const deps: ApprovalHandlerDeps = {
    countTodayApplications: () => 0,
    configStore,
    db,
    hhHybrid,
    llm: createDummyLlm(),
  };

  const res = await handleApprovalAction('send', 2, deps);
  assert.equal(res.error, null);
  assert.ok(res.data?.updatedText.includes('Требуется ручное прохождение теста'));

  const row = db.select().from(applicationRecords).limit(1).get();
  assert.equal(row?.status, 'pending_approval');
  assert.equal(row?.lastEmployerMessage, 'Требуется ручное прохождение теста');
  assert.equal(row?.isNotified, true);
});

test('handleApprovalAction - regen action regenerates cover letter using vacancy details and llm', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  db.insert(userProfiles).values({
    hhResumeTitle: 'FullStack',
    resumeRawText: 'Node.js React TypeScript',
    customPromptRules: 'Будь лаконичен',
  }).run();

  db.insert(applicationRecords).values({
    id: 3,
    vacancyId: 'vac-3',
    companyName: 'RegenCorp',
    positionTitle: 'Senior Fullstack',
    salaryText: '350 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-3',
    coverLetter: 'Старое письмо',
    status: 'pending_approval',
    matchScore: 88,
    aiReasoning: 'Хорошее совпадение стека',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  let detailsRequestedVacancyId = '';
  const hhHybrid = createDummyHhHybrid({
    getVacancyDetails: async (id) => {
      detailsRequestedVacancyId = id;
      return {
        data: {
          vacancyId: id,
          title: 'Senior Fullstack',
          companyName: 'RegenCorp',
          salary: '350 000',
          cleanDescription: 'Ищем опытного фуллстек разработчика с отличным знанием Node.js.',
          employerQuestions: [],
          rawHtml: '',
        },
        error: null,
      };
    },
  });

  let generateInputCaptured: unknown = null;
  const llm = createDummyLlm({
    generateCoverLetter: async (input) => {
      generateInputCaptured = input;
      return { data: 'Новое свежее сопроводительное письмо от ИИ', error: null };
    },
  });

  const deps: ApprovalHandlerDeps = {
    countTodayApplications: () => 0,
    configStore,
    db,
    hhHybrid,
    llm,
  };

  const res = await handleApprovalAction('regen', 3, deps);
  assert.equal(res.error, null);
  assert.equal(detailsRequestedVacancyId, 'vac-3');
  assert.ok(res.data?.updatedText.includes('Новое свежее сопроводительное письмо'));
  assert.ok(res.data?.updatedKeyboard);

  const castInput = generateInputCaptured as { temperature?: number; customPromptRules?: string };
  assert.equal(castInput.temperature, 0.65);
  assert.equal(castInput.customPromptRules, 'Будь лаконичен');

  const row = db.select().from(applicationRecords).limit(1).get();
  assert.equal(row?.coverLetter, 'Новое свежее сопроводительное письмо от ИИ');
});

test('handleApprovalAction - skip and bl actions', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  db.insert(applicationRecords).values({
    id: 4,
    vacancyId: 'vac-4',
    companyName: 'BadEmployer',
    positionTitle: 'Intern',
    salaryText: '10 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-4',
    coverLetter: 'Письмо',
    status: 'pending_approval',
    matchScore: 50,
    aiReasoning: 'Low match',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  const deps: ApprovalHandlerDeps = {
    countTodayApplications: () => 0,
    configStore,
    db,
    hhHybrid: createDummyHhHybrid(),
    llm: createDummyLlm(),
  };

  const skipRes = await handleApprovalAction('skip', 4, deps);
  assert.equal(skipRes.error, null);
  assert.ok(skipRes.data?.updatedText.includes('Вакансия пропущена'));

  let row = db.select().from(applicationRecords).limit(1).get();
  assert.equal(row?.status, 'skipped_user');
  assert.equal(row?.isNotified, true);

  db.insert(applicationRecords).values({
    id: 5,
    vacancyId: 'vac-5',
    companyName: 'ScamAgency',
    positionTitle: 'Junior',
    salaryText: '5 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-5',
    coverLetter: 'Письмо',
    status: 'pending_approval',
    matchScore: 40,
    aiReasoning: 'Very low',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  const blRes = await handleApprovalAction('bl', 5, deps);
  assert.equal(blRes.error, null);
  assert.ok(blRes.data?.updatedText.includes('добавлена в черный список'));

  assert.equal(configStore.isCompanyBlacklisted('ScamAgency').data, true);
  row = db.select().from(applicationRecords).where(applicationRecords.id.as('id')).limit(10).all().find((r) => r.id === 5);
  assert.equal(row?.status, 'skipped_user');
});

test('TelegramBotService countTodayApplications excludes pending_approval, skipped_user and skipped_low_score', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm()
  );

  const now = new Date().toISOString();

  db.insert(applicationRecords).values([
    {
      vacancyId: '1',
      companyName: 'C1',
      positionTitle: 'P1',
      salaryText: 'S1',
      vacancyUrl: 'U1',
      coverLetter: 'L1',
      status: 'pending_approval',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: '2',
      companyName: 'C2',
      positionTitle: 'P2',
      salaryText: 'S2',
      vacancyUrl: 'U2',
      coverLetter: 'L2',
      status: 'skipped_user',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: '3',
      companyName: 'C3',
      positionTitle: 'P3',
      salaryText: 'S3',
      vacancyUrl: 'U3',
      coverLetter: 'L3',
      status: 'skipped_low_score',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: '4',
      companyName: 'C4',
      positionTitle: 'P4',
      salaryText: 'S4',
      vacancyUrl: 'U4',
      coverLetter: 'L4',
      status: 'response',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: '5',
      companyName: 'C5',
      positionTitle: 'P5',
      salaryText: 'S5',
      vacancyUrl: 'U5',
      coverLetter: 'L5',
      status: 'invitation',
      appliedAt: now,
      updatedAt: now,
    },
  ]).run();

  assert.equal(botService.countTodayApplications(), 2);
});

test('TelegramBotService buildAutomationSettingsText and buildAutomationSettingsKeyboard', () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm()
  );

  const settingsText = botService.buildAutomationSettingsText();
  assert.ok(settingsText.includes('Настройки автоматизации и ИИ'));
  assert.ok(settingsText.includes('Режим одобрения откликов'));
  assert.ok(settingsText.includes('Минимальный порог'));

  const settingsKb = botService.buildAutomationSettingsKeyboard();
  assert.ok(settingsKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'settings:min_score')));
  assert.ok(settingsKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'settings:toggle_approval_mode')));
  assert.ok(settingsKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'settings:toggle_auto_bump')));
  assert.ok(settingsKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'settings:toggle_answer_questions')));
  assert.ok(settingsKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:back_to_main')));

  const mainKb = botService.buildMainMenuKeyboard();
  assert.ok(mainKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:blacklist')));
  assert.ok(mainKb.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:automation_settings')));

  const mainText = botService.buildMainMenuText();
  assert.ok(mainText.includes('Режим одобрения'));
  assert.ok(mainText.includes('Мин. порог ИИ'));
  assert.ok(mainText.includes('Автоподнятие резюме'));
  assert.ok(mainText.includes('Автоответы на анкеты'));
});

test('TelegramBotService syncBotCommandMenu registers BOT_MENU_COMMANDS and pins commands menu button', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

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
    return { ok: true, result: true as never };
  });

  const result = await botService.syncBotCommandMenu();
  assert.equal(result.error, null);
  assert.equal(result.data, true);

  const setCommandsCall = apiCalls.find((c) => c.method === 'setMyCommands');
  assert.ok(setCommandsCall);
  assert.equal(BOT_MENU_COMMANDS.length, 11);
  assert.ok(BOT_MENU_COMMANDS.some((cmd) => cmd.command === 'status'));
  assert.ok(BOT_MENU_COMMANDS.some((cmd) => cmd.command === 'logs'));
  assert.ok(BOT_MENU_COMMANDS.some((cmd) => cmd.command === 'menu'));
  assert.ok(BOT_MENU_COMMANDS.some((cmd) => cmd.command === 'settings'));
  assert.ok(BOT_MENU_COMMANDS.some((cmd) => cmd.command === 'blacklist'));

  const setMenuButtonCall = apiCalls.find((c) => c.method === 'setChatMenuButton');
  assert.ok(setMenuButtonCall);
  assert.deepEqual(setMenuButtonCall.payload, { menu_button: { type: 'commands' } });
});

test('handleApprovalAction prevents duplicate concurrent send execution for the same recordId', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  db.insert(applicationRecords).values({
    id: 55,
    vacancyId: 'vac-55',
    companyName: 'ConcurrentCorp',
    positionTitle: 'Concurrency Dev',
    salaryText: '100 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-55',
    coverLetter: 'Concurrent letter',
    status: 'pending_approval',
    matchScore: 85,
    aiReasoning: 'Match',
    lastEmployerMessage: null,
    isNotified: false,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  let applyCalls = 0;
  const slowDeps: ApprovalHandlerDeps = {
    countTodayApplications: () => 0,
    configStore,
    db,
    hhHybrid: createDummyHhHybrid({
      applyToVacancy: async () => {
        applyCalls++;
        await new Promise((r) => setTimeout(r, 60));
        return { data: true, error: null };
      },
    }),
    llm: createDummyLlm(),
  };

  const [res1, res2] = await Promise.all([
    handleApprovalAction('send', 55, slowDeps),
    handleApprovalAction('send', 55, slowDeps),
  ]);

  assert.equal(applyCalls, 1);
  assert.ok(res1.data || res2.data);
  assert.ok(
    res1.error?.includes('уже выполняется') || res2.error?.includes('уже выполняется')
  );
});

test('handleApprovalAction send action is a no-op when record status is already response', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  db.insert(applicationRecords).values({
    id: 56,
    vacancyId: 'vac-56',
    companyName: 'AlreadyAppliedCorp',
    positionTitle: 'Applied Dev',
    salaryText: '150 000',
    vacancyUrl: 'https://hh.ru/vacancy/vac-56',
    coverLetter: 'Applied letter',
    status: 'response',
    matchScore: 90,
    aiReasoning: 'Applied match',
    lastEmployerMessage: null,
    isNotified: true,
    appliedAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  }).run();

  let applyCalls = 0;
  const deps: ApprovalHandlerDeps = {
    countTodayApplications: () => 0,
    configStore,
    db,
    hhHybrid: createDummyHhHybrid({
      applyToVacancy: async () => {
        applyCalls++;
        return { data: true, error: null };
      },
    }),
    llm: createDummyLlm(),
  };

  const res = await handleApprovalAction('send', 56, deps);
  assert.equal(applyCalls, 0);
  assert.equal(res.error, null);
  assert.ok(res.data);
  assert.ok(res.data.updatedText.includes('уже отправлен') || res.data.updatedText.includes('уже был отправлен'));
});

test('TelegramBotService API transformer automatically retries 429 Too Many Requests if retry_after <= 30', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456789:ABCDEF12345678901234567890123456789', '987654321');

  const sleepDurations: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleepDurations.push(ms);
  };

  let callCount = 0;
  const fakeFetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 2',
          parameters: { retry_after: 2 },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 101, date: 1700000000, chat: { id: 987654321, type: 'private' } },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm(),
    { sleepFn: fakeSleep, clientFetch: fakeFetch }
  );

  const res = await botService.sendAdminMessage('Test 429 retry');
  assert.equal(res.error, null);
  assert.equal(res.data, true);
  assert.equal(callCount, 2);
  assert.deepEqual(sleepDurations, [2000]);
});

test('TelegramBotService API transformer does not retry 429 if retry_after > 30', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456789:ABCDEF12345678901234567890123456789', '987654321');

  const sleepDurations: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleepDurations.push(ms);
  };

  let callCount = 0;
  const fakeFetch = (async () => {
    callCount++;
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 60',
        parameters: { retry_after: 60 },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    createDummyHhHybrid(),
    createDummyLlm(),
    { sleepFn: fakeSleep, clientFetch: fakeFetch }
  );

  const res = await botService.sendAdminMessage('Test 429 unhandled');
  assert.ok(res.error);
  assert.equal(callCount, 1);
  assert.deepEqual(sleepDurations, []);
});

