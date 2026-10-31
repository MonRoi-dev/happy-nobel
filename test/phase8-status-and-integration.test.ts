import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabaseContext } from '../src/db/index.ts';
import {
  applicationRecords,
  taskQueue,
  userProfiles,
  searchFilters,
} from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/index.ts';
import {
  HhBrowserCaptchaService,
  type CaptchaChallengeSnapshot,
  type IHhHybridService,
} from '../src/modules/hh-hybrid/index.ts';
import type { ILlmService } from '../src/modules/llm/index.ts';
import {
  computeRandomDelayMs,
  SchedulerService,
} from '../src/modules/scheduler/index.ts';
import {
  buildCompactStatusKeyboard,
  buildCompactStatusText,
  formatStatusIcon,
  queryCompactStatusReport,
  registerStatusHandlers,
  TelegramBotService,
  STATUS_PAGE_SIZE,
} from '../src/modules/telegram/index.ts';

function createDummyHhHybrid(overrides: Partial<IHhHybridService> = {}): IHhHybridService {
  return {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({ data: { items: [], found: 0, pages: 0, page: 0, perPage: 20 }, error: null }),
    getVacancyDetails: async (id = '100') => ({
      data: {
        vacancy: {
          id,
          name: 'Node.js Developer',
          description: 'Detailed description for testing',
          alternate_url: `https://hh.ru/vacancy/${id}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'Acme Corp' },
          key_skills: [],
        },
        cleanDescription: 'Detailed description for testing',
        salaryText: '250 000 руб.',
        vacancyId: id,
        title: 'Node.js Developer',
        companyName: 'Acme Corp',
        salary: '250000',
        employerQuestions: [],
        rawHtml: '',
      },
      error: null,
    }),
    applyToVacancy: async () => ({ data: true, error: null }),
    bumpResume: async () => ({ data: { bumped: true, nextBumpAvailableAt: new Date().toISOString() }, error: null }),
    syncNegotiations: async () => ({ data: { updatedCount: 0, items: [] }, error: null }),
    ...overrides,
  };
}

function createDummyLlm(overrides: Partial<ILlmService> = {}): ILlmService {
  return {
    evaluateVacancy: async () => ({
      data: {
        matchScore: 90,
        reasoning: 'Good match',
        coverLetter: 'Cover letter content',
      },
      error: null,
    }),
    generateCoverLetter: async () => ({ data: 'Cover letter', error: null }),
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
      },
      error: null,
    }),
    listAvailableModels: async () => ({ data: [{ name: 'gemma4:64k', size: 1000 }], error: null }),
    ...overrides,
  };
}

test('formatStatusIcon returns corresponding icons for all statuses', () => {
  assert.equal(formatStatusIcon('invitation'), '🟢');
  assert.equal(formatStatusIcon('discard'), '🔴');
  assert.equal(formatStatusIcon('viewed'), '👀');
  assert.equal(formatStatusIcon('response'), '⏳');
  assert.equal(formatStatusIcon('other_status'), '⏳');
});

test('Compact Status Report Metrics & Pagination (5 per page)', () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();
  configStore.setDailyLimit(50);
  configStore.set('AUTO_APPLY_ENABLED', 'true');

  const now = new Date().toISOString();

  dbContext.db.insert(applicationRecords).values([
    {
      vacancyId: 'vac-1',
      companyName: 'Alpha Tech',
      positionTitle: 'Backend Engineer',
      salaryText: '200 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-1',
      coverLetter: 'Letter 1',
      status: 'invitation',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-2',
      companyName: 'Beta Systems',
      positionTitle: 'Fullstack Dev',
      salaryText: '220 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-2',
      coverLetter: 'Letter 2',
      status: 'invitation',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-3',
      companyName: 'Gamma Soft',
      positionTitle: 'Team Lead',
      salaryText: '300 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-3',
      coverLetter: 'Letter 3',
      status: 'discard',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-4',
      companyName: 'Delta Labs',
      positionTitle: 'DevOps',
      salaryText: '250 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-4',
      coverLetter: 'Letter 4',
      status: 'response',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-5',
      companyName: 'Epsilon AI',
      positionTitle: 'ML Engineer',
      salaryText: '350 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-5',
      coverLetter: 'Letter 5',
      status: 'response',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-6',
      companyName: 'Zeta Cloud',
      positionTitle: 'Cloud Architect',
      salaryText: '400 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-6',
      coverLetter: 'Letter 6',
      status: 'viewed',
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'vac-7',
      companyName: 'Pending Inc',
      positionTitle: 'Intern',
      salaryText: '50 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/vac-7',
      coverLetter: 'Letter 7',
      status: 'pending_approval',
      appliedAt: now,
      updatedAt: now,
    },
  ]).run();

  dbContext.db.insert(taskQueue).values([
    {
      taskType: 'SEND_TG_MESSAGE',
      payloadJson: '{}',
      status: 'pending',
      scheduledFor: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      taskType: 'APPLY_VACANCY',
      payloadJson: '{}',
      status: 'pending',
      scheduledFor: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).run();

  const page0 = queryCompactStatusReport(dbContext.db, configStore, 0, STATUS_PAGE_SIZE);

  assert.equal(page0.todayApplied, 6);
  assert.equal(page0.pendingQueueCount, 2);
  assert.equal(page0.dailyLimit, 50);
  assert.equal(page0.totals.totalApplied, 6);
  assert.equal(page0.totals.invitations, 2);
  assert.equal(page0.totals.discards, 1);
  assert.equal(page0.totals.awaitingResponse, 3);
  assert.equal(page0.totalPages, 2);
  assert.equal(page0.items.length, 5);
  assert.equal(page0.page, 0);

  const text0 = buildCompactStatusText(page0);
  assert.ok(text0.includes('📊 <b>Краткий отчет по откликам (Статус)</b>'));
  assert.ok(text0.includes('🟢'));
  assert.ok(text0.includes('🔴'));
  assert.ok(text0.includes('⏳'));
  assert.ok(text0.includes('1.'));
  assert.ok(text0.includes('2.'));
  assert.ok(text0.includes('3.'));
  assert.ok(text0.includes('4.'));
  assert.ok(text0.includes('5.'));
  assert.ok(!text0.includes('6. '));

  const page1 = queryCompactStatusReport(dbContext.db, configStore, 1, STATUS_PAGE_SIZE);
  assert.equal(page1.page, 1);
  assert.equal(page1.items.length, 1);

  const text1 = buildCompactStatusText(page1);
  assert.ok(text1.includes('6.'));

  const kb0 = buildCompactStatusKeyboard(0, 2);
  const rows0 = kb0.inline_keyboard;
  assert.ok(rows0.some((r) => r.some((b) => b.callback_data === 'status:page:1')));
  assert.ok(!rows0.some((r) => r.some((b) => b.callback_data === 'status:page:-1')));
  assert.ok(rows0.some((r) => r.some((b) => b.callback_data === 'menu:export_excel')));

  const kb1 = buildCompactStatusKeyboard(1, 2);
  const rows1 = kb1.inline_keyboard;
  assert.ok(rows1.some((r) => r.some((b) => b.callback_data === 'status:page:0')));
  assert.ok(!rows1.some((r) => r.some((b) => b.callback_data === 'status:page:2')));

  dbContext.close();
});

test('Bot Operational State in Status Header reflects captcha, active, and paused modes', () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();

  configStore.set('AUTO_APPLY_ENABLED', 'true');
  const activeReport = queryCompactStatusReport(dbContext.db, configStore, 0, 5, false);
  assert.equal(activeReport.botState, 'active');
  const activeText = buildCompactStatusText(activeReport);
  assert.ok(activeText.includes('🟢 Активен'));

  configStore.set('AUTO_APPLY_ENABLED', 'false');
  const pausedReport = queryCompactStatusReport(dbContext.db, configStore, 0, 5, false);
  assert.equal(pausedReport.botState, 'paused');
  const pausedText = buildCompactStatusText(pausedReport);
  assert.ok(pausedText.includes('⏸ На паузе'));

  const captchaPausedReport = queryCompactStatusReport(dbContext.db, configStore, 0, 5, true);
  assert.equal(captchaPausedReport.botState, 'paused_captcha');
  const captchaPausedText = buildCompactStatusText(captchaPausedReport);
  assert.ok(captchaPausedText.includes('⚠️ Ожидает капчу'));

  const now = new Date().toISOString();
  dbContext.db.insert(taskQueue).values({
    taskType: 'APPLY_VACANCY',
    payloadJson: '{}',
    status: 'paused_captcha',
    scheduledFor: now,
    createdAt: now,
    updatedAt: now,
  }).run();

  const dbCaptchaReport = queryCompactStatusReport(dbContext.db, configStore, 0, 5, false);
  assert.equal(dbCaptchaReport.botState, 'paused_captcha');
  const dbCaptchaText = buildCompactStatusText(dbCaptchaReport);
  assert.ok(dbCaptchaText.includes('⚠️ Ожидает капчу'));

  dbContext.close();
});

test('Empty applications list renders fallback placeholder in status text', () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();

  const emptyReport = queryCompactStatusReport(dbContext.db, configStore, 0, 5);
  assert.equal(emptyReport.items.length, 0);
  assert.equal(emptyReport.totals.totalApplied, 0);

  const text = buildCompactStatusText(emptyReport);
  assert.ok(text.includes('Откликов пока нет.'));

  const kb = buildCompactStatusKeyboard(0, 1);
  assert.equal(kb.inline_keyboard.length, 3);
  assert.ok(kb.inline_keyboard.some((r) => r.some((b) => b.callback_data === 'menu:export_excel')));
  assert.ok(kb.inline_keyboard.some((r) => r.some((b) => b.callback_data === 'menu:back_to_main')));

  dbContext.close();
});

test('Scheduler Captcha Interception stops cycle and notifies captchaService without skipping vacancy', async () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.setDailyLimit(10);

  dbContext.db.insert(userProfiles).values({
    hhResumeTitle: 'Senior TypeScript Dev',
    resumeRawText: 'TypeScript Node.js SQL Playwright',
    customPromptRules: null,
  }).run();

  dbContext.db.insert(searchFilters).values({
    queryText: 'TypeScript',
    excludedWords: null,
    areaId: '1',
    schedule: null,
    salaryFrom: null,
  }).run();

  let captchaSnapshotCaptured: CaptchaChallengeSnapshot | null = null;
  const captchaService = new HhBrowserCaptchaService({
    detector: {
      detectCaptchaOnPage: async () => false,
      detectCaptchaInHtml: () => false,
      captureChallengeSnapshot: async () => ({ detected: false, pageUrl: '' }),
    },
    onNotifyCaptcha: async (snapshot) => {
      captchaSnapshotCaptured = snapshot;
      return { data: true, error: null };
    },
  });

  const hhHybrid = createDummyHhHybrid({
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: 'captcha-vac-1',
            name: 'Frontend Lead',
            employer: { name: 'Captcha Inc' },
            alternate_url: 'https://hh.ru/vacancy/captcha-vac-1',
            has_test: false,
            response_letter_required: false,
            archived: false,
          },
          {
            id: 'vac-should-not-run',
            name: 'Backend Lead',
            employer: { name: 'Followup Inc' },
            alternate_url: 'https://hh.ru/vacancy/vac-should-not-run',
            has_test: false,
            response_letter_required: false,
            archived: false,
          },
        ],
        found: 2,
        pages: 1,
        page: 0,
        perPage: 20,
      },
      error: null,
    }),
    getVacancyDetails: async (id) => ({
      data: {
        vacancy: {
          id,
          name: 'Frontend Lead',
          description: 'Detailed description for captcha test',
          alternate_url: `https://hh.ru/vacancy/${id}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'Captcha Inc' },
          key_skills: [],
        },
        cleanDescription: 'Detailed description for captcha test',
        salaryText: '300 000 руб.',
        vacancyId: id,
        title: 'Frontend Lead',
        companyName: 'Captcha Inc',
        salary: '300000',
        employerQuestions: [],
        rawHtml: '',
      },
      error: null,
    }),
    applyToVacancy: async () => ({
      data: null,
      error: 'CAPTCHA_REQUIRED',
    }),
  });

  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    dbContext.db,
    hhHybrid,
    createDummyLlm(),
    { captchaService }
  );

  const scheduler = new SchedulerService(
    configStore,
    dbContext.db,
    hhHybrid,
    createDummyLlm(),
    telegramBot,
    {
      captchaService,
      customSleep: async () => {},
    }
  );

  const cycleResult = await scheduler.runAutoApplyCycle();

  assert.equal(cycleResult.error, null);
  assert.equal(cycleResult.data?.appliedCount, 0);

  assert.ok(captchaSnapshotCaptured !== null);
  assert.equal((captchaSnapshotCaptured as CaptchaChallengeSnapshot).detected, true);
  assert.equal(
    (captchaSnapshotCaptured as CaptchaChallengeSnapshot).pageUrl,
    'https://hh.ru/vacancy/captcha-vac-1'
  );

  const rows = dbContext.db.select().from(applicationRecords).limit(10).all();
  const skippedUserRow = rows.find((r) => r.status === 'skipped_user');
  assert.equal(skippedUserRow, undefined);

  dbContext.close();
});

test('computeRandomDelayMs uses jitter when default parameters given, and randomInt when custom', () => {
  const defaultDelay = computeRandomDelayMs();
  assert.ok(defaultDelay >= 60_000);
  assert.ok(defaultDelay <= 600_000);

  const customDelay = computeRandomDelayMs(50, 100);
  assert.ok(customDelay >= 50);
  assert.ok(customDelay <= 100);

  const invertedDelay = computeRandomDelayMs(200, 100);
  assert.equal(invertedDelay, 200);
});

test('registerStatusHandlers registers command and callback handlers and dispatches updates', async () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    dbContext.db,
    createDummyHhHybrid(),
    createDummyLlm()
  );

  let repliedText = '';
  let repliedMarkup: unknown = null;

  const mockCtx = {
    from: { id: 123456789 },
    reply: async (text: string, options?: { reply_markup?: unknown }) => {
      repliedText = text;
      repliedMarkup = options?.reply_markup;
      return {} as never;
    },
    answerCallbackQuery: async () => {},
    match: ['status:page:1', '1'],
  };

  const statusHandlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  botService.bot.command = ((cmd: string, handler: (ctx: unknown) => Promise<void>) => {
    statusHandlers[`command:${cmd}`] = handler;
    return botService.bot;
  }) as never;

  botService.bot.callbackQuery = ((trigger: unknown, handler: (ctx: unknown) => Promise<void>) => {
    const key = typeof trigger === 'string' ? trigger : 'regex_page';
    statusHandlers[key] = handler;
    return botService.bot;
  }) as never;

  let editedText = '';
  let editedMarkup: unknown = null;
  registerStatusHandlers(botService.bot, {
    db: dbContext.db,
    configStore,
    safeEditMessageText: async (_ctx, text, other) => {
      editedText = text;
      editedMarkup = other?.reply_markup;
    },
  });

  const commandHandler = statusHandlers['command:status'];
  assert.ok(typeof commandHandler === 'function');
  await commandHandler(mockCtx);
  assert.ok(repliedText.includes('📊 <b>Краткий отчет по откликам (Статус)</b>'));
  assert.ok(repliedMarkup !== null);

  const menuStatusHandler = statusHandlers['menu:status'];
  assert.ok(typeof menuStatusHandler === 'function');
  await menuStatusHandler(mockCtx);
  assert.ok(editedText.includes('📊 <b>Краткий отчет по откликам (Статус)</b>'));
  assert.ok(editedMarkup !== null);

  const pageHandler = statusHandlers['regex_page'];
  assert.ok(typeof pageHandler === 'function');
  await pageHandler(mockCtx);
  assert.ok(editedText.includes('📊 <b>Краткий отчет по откликам (Статус)</b>'));

  dbContext.close();
});

test('TelegramBotService sendCaptchaAlert sends photo when screenshotBuffer available', async () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();
  configStore.set('TG_ADMIN_ID', '999888');

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    dbContext.db,
    createDummyHhHybrid(),
    createDummyLlm()
  );

  const apiCalls: Array<{ method: string; payload: unknown }> = [];
  botService.bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    return { ok: true, result: true as never };
  });

  const res = await botService.sendCaptchaAlert({
    detected: true,
    pageUrl: 'https://hh.ru/vacancy/111',
    screenshotBuffer: Buffer.from('test_png_data'),
  });

  assert.equal(res.error, null);
  assert.equal(res.data, true);

  const photoCall = apiCalls.find((c) => c.method === 'sendPhoto');
  assert.ok(photoCall);
  const payload = photoCall.payload as { chat_id: string; caption: string };
  assert.equal(payload.chat_id, '999888');
  assert.ok(payload.caption.includes('HH.ru запросил прохождение капчи'));

  dbContext.close();
});

test('Scheduler runAutoApplyCycle advances to page 1 when all 20 items on page 0 are already processed', async () => {
  const dbContext = createDatabaseContext(':memory:');
  const configStore = new ConfigStoreService(dbContext.db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.setDailyLimit(20);

  dbContext.db.insert(userProfiles).values({
    hhResumeTitle: 'Senior Backend Dev',
    resumeRawText: 'Node.js TypeScript PostgreSQL',
    customPromptRules: null,
  }).run();

  dbContext.db.insert(searchFilters).values({
    queryText: 'Node.js TypeScript Backend',
    excludedWords: null,
    areaId: null,
    schedule: null,
    salaryFrom: null,
  }).run();

  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();
  const page0Items = Array.from({ length: 20 }, (_, i) => {
    const id = `old-vac-${i + 1}`;
    dbContext.db.insert(applicationRecords).values({
      vacancyId: id,
      companyName: `Old Co ${i + 1}`,
      positionTitle: `Old Role ${i + 1}`,
      salaryText: '200 000 руб.',
      vacancyUrl: `https://hh.ru/vacancy/${id}`,
      coverLetter: 'old',
      status: 'response',
      isNotified: true,
      appliedAt: yesterdayIso,
      updatedAt: yesterdayIso,
    }).run();
    return {
      id,
      name: `Old Role ${i + 1}`,
      employer: { name: `Old Co ${i + 1}` },
      alternate_url: `https://hh.ru/vacancy/${id}`,
      has_test: false,
      response_letter_required: false,
      archived: false,
    };
  });

  const queriedPages: number[] = [];
  const appliedIds: string[] = [];

  const hhHybrid = createDummyHhHybrid({
    searchVacancies: async (query) => {
      const page = query.page ?? 0;
      queriedPages.push(page);
      if (page === 0) {
        return {
          data: { items: page0Items, found: 25, pages: 2, page: 0, per_page: 50 },
          error: null,
        };
      }
      return {
        data: {
          items: [
            {
              id: 'fresh-page1-vac',
              name: 'Fresh Page 1 Backend Role',
              employer: { name: 'Fresh Corp' },
              alternate_url: 'https://hh.ru/vacancy/fresh-page1-vac',
              has_test: false,
              response_letter_required: false,
              archived: false,
            },
          ],
          found: 25,
          pages: 2,
          page: 1,
          per_page: 50,
        },
        error: null,
      };
    },
    getVacancyDetails: async (id) => ({
      data: {
        vacancy: {
          id,
          name: 'Fresh Page 1 Backend Role',
          description: 'Node.js TypeScript microservices backend role',
          alternate_url: `https://hh.ru/vacancy/${id}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'Fresh Corp' },
          key_skills: [],
        },
        cleanDescription: 'Node.js TypeScript microservices backend role',
        salaryText: '350 000 руб.',
        vacancyId: id,
        title: 'Fresh Page 1 Backend Role',
        companyName: 'Fresh Corp',
        salary: '350000',
        employerQuestions: [],
        rawHtml: '',
      },
      error: null,
    }),
    applyToVacancy: async (params) => {
      appliedIds.push(params.vacancyId);
      return { data: true, error: null };
    },
  });

  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    dbContext.db,
    hhHybrid,
    createDummyLlm()
  );

  const scheduler = new SchedulerService(
    configStore,
    dbContext.db,
    hhHybrid,
    createDummyLlm(),
    telegramBot,
    { customSleep: async () => {} }
  );

  const cycleRes = await scheduler.runAutoApplyCycle();
  assert.equal(cycleRes.error, null);
  assert.deepEqual(queriedPages, [0, 1]);
  assert.deepEqual(appliedIds, ['fresh-page1-vac']);
  assert.equal(cycleRes.data?.appliedCount, 1);
  assert.equal(cycleRes.data?.skippedCount, 20);

  dbContext.close();
});
