import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import ExcelJS from 'exceljs';
import { applicationRecords, searchFilters, userProfiles } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/index.ts';
import { ExcelExporterService } from '../src/modules/exporter/index.ts';
import type { IHhHybridService } from '../src/modules/hh-hybrid/index.ts';
import type { ILlmService } from '../src/modules/llm/index.ts';
import { SchedulerService } from '../src/modules/scheduler/index.ts';
import { TelegramBotService } from '../src/modules/telegram/index.ts';

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

test('SchedulerService skips companies matching company_blacklist before calling getVacancyDetails or llm.evaluateVacancy', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.addBlacklistedCompany('Blacklisted Corp');

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Node.js TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const detailsCalls: string[] = [];
  const evalCalls: string[] = [];

  const hhHybrid = createDummyHhHybrid({
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: 'vac-blacklisted',
            name: 'Backend Dev',
            alternate_url: 'https://hh.ru/vacancy/vac-blacklisted',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Blacklisted Corp' },
          },
          {
            id: 'vac-allowed',
            name: 'Backend Dev',
            alternate_url: 'https://hh.ru/vacancy/vac-allowed',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Good Corp' },
          },
        ],
        found: 2,
        pages: 1,
        page: 0,
        perPage: 20,
      },
      error: null,
    }),
    getVacancyDetails: async (vacancyId: string) => {
      detailsCalls.push(vacancyId);
      return {
        data: {
          vacancy: {
            id: vacancyId,
            name: 'Backend Dev',
            description: 'Good vacancy description for backend dev',
            alternate_url: `https://hh.ru/vacancy/${vacancyId}`,
            archived: false,
            has_test: false,
            response_letter_required: false,
            salary: null,
            employer: { name: vacancyId === 'vac-blacklisted' ? 'Blacklisted Corp' : 'Good Corp' },
            key_skills: [],
          },
          cleanDescription: 'Good vacancy description for backend dev',
          salaryText: '200 000 руб.',
        },
        error: null,
      };
    },
  });

  const llm = createDummyLlm({
    evaluateVacancy: async (input) => {
      evalCalls.push(input.companyName);
      return {
        data: {
          matchScore: 90,
          reasoning: 'Отличное совпадение',
          coverLetter: 'Здравствуйте! Готов приступить к работе над проектом.',
        },
        error: null,
      };
    },
  });

  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    hhHybrid,
    llm
  );

  const scheduler = new SchedulerService(configStore, db, hhHybrid, llm, telegramBot, {
    minDelayMs: 0,
    maxDelayMs: 0,
    customSleep: async () => {},
  });
  const result = await scheduler.runAutoApplyCycle();

  assert.equal(result.error, null);
  assert.equal(detailsCalls.includes('vac-blacklisted'), false);
  assert.equal(detailsCalls.includes('vac-allowed'), true);
  assert.equal(evalCalls.includes('Blacklisted Corp'), false);
  assert.equal(evalCalls.includes('Good Corp'), true);
});

test('SchedulerService stores status: skipped_low_score with matchScore and aiReasoning when matchScore < MIN_MATCH_SCORE, and does not consume daily limit', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.setMinMatchScore(75);

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Node.js TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const hhHybrid = createDummyHhHybrid({
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: 'vac-low-score',
            name: 'PHP Developer',
            alternate_url: 'https://hh.ru/vacancy/vac-low-score',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Legacy Systems' },
          },
        ],
        found: 1,
        pages: 1,
        page: 0,
        perPage: 20,
      },
      error: null,
    }),
    getVacancyDetails: async (vacancyId: string) => ({
      data: {
        vacancy: {
          id: vacancyId,
          name: 'PHP Developer',
          description: 'Требуется знание древнего PHP 5.3 и Perl',
          alternate_url: `https://hh.ru/vacancy/${vacancyId}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'Legacy Systems' },
          key_skills: [],
        },
        cleanDescription: 'Требуется знание древнего PHP 5.3 и Perl',
        salaryText: '50 000 руб.',
      },
      error: null,
    }),
  });

  const llm = createDummyLlm({
    evaluateVacancy: async () => ({
      data: {
        matchScore: 35,
        reasoning: 'Стек кандидата Node.js не совпадает с требованиями PHP/Perl',
        coverLetter: '',
      },
      error: null,
    }),
  });

  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    hhHybrid,
    llm
  );

  const scheduler = new SchedulerService(configStore, db, hhHybrid, llm, telegramBot, {
    minDelayMs: 0,
    maxDelayMs: 0,
    customSleep: async () => {},
  });
  const result = await scheduler.runAutoApplyCycle();

  assert.equal(result.error, null);
  assert.equal(result.data?.appliedCount, 0);

  const row = db
    .select()
    .from(applicationRecords)
    .where(eq(applicationRecords.vacancyId, 'vac-low-score'))
    .limit(1)
    .get();

  assert.ok(row);
  assert.equal(row.status, 'skipped_low_score');
  assert.equal(row.matchScore, 35);
  assert.equal(row.aiReasoning, 'Стек кандидата Node.js не совпадает с требованиями PHP/Perl');
  assert.equal(scheduler.countTodayApplications(), 0);
});

test('SchedulerService in APPROVAL_MODE = manual stores status: pending_approval, calls telegramBot.sendApprovalCard, does not consume daily limit, and respects maxPendingApprovals', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.setApprovalMode('manual');

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Node.js TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const hhHybrid = createDummyHhHybrid({
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: 'vac-manual-1',
            name: 'Senior Dev 1',
            alternate_url: 'https://hh.ru/vacancy/vac-manual-1',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Alpha Tech' },
          },
          {
            id: 'vac-manual-2',
            name: 'Senior Dev 2',
            alternate_url: 'https://hh.ru/vacancy/vac-manual-2',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Beta Tech' },
          },
        ],
        found: 2,
        pages: 1,
        page: 0,
        perPage: 20,
      },
      error: null,
    }),
    getVacancyDetails: async (vacancyId: string) => ({
      data: {
        vacancy: {
          id: vacancyId,
          name: vacancyId === 'vac-manual-1' ? 'Senior Dev 1' : 'Senior Dev 2',
          description: 'Отличная позиция разработчика',
          alternate_url: `https://hh.ru/vacancy/${vacancyId}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: vacancyId === 'vac-manual-1' ? 'Alpha Tech' : 'Beta Tech' },
          key_skills: [],
        },
        cleanDescription: 'Отличная позиция разработчика с современным стеком',
        salaryText: '300 000 руб.',
      },
      error: null,
    }),
  });

  const llm = createDummyLlm({
    evaluateVacancy: async () => ({
      data: {
        matchScore: 92,
        reasoning: 'Идеальное совпадение по стеку TypeScript',
        coverLetter: 'Здравствуйте! Готов внести вклад в ваш проект.',
      },
      error: null,
    }),
  });

  const cardsSent: unknown[] = [];
  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    hhHybrid,
    llm
  );
  telegramBot.sendApprovalCard = async (record) => {
    cardsSent.push(record);
    return { data: true, error: null };
  };

  const scheduler = new SchedulerService(configStore, db, hhHybrid, llm, telegramBot, {
    maxPendingApprovals: 1,
    manualApprovalDelayMs: 1,
    minDelayMs: 0,
    maxDelayMs: 0,
    customSleep: async () => {},
  });

  const result = await scheduler.runAutoApplyCycle();

  assert.equal(result.error, null);
  assert.equal(cardsSent.length, 1);

  const row1 = db
    .select()
    .from(applicationRecords)
    .where(eq(applicationRecords.vacancyId, 'vac-manual-1'))
    .limit(1)
    .get();

  assert.ok(row1);
  assert.equal(row1.status, 'pending_approval');
  assert.equal(row1.matchScore, 92);
  assert.equal(row1.aiReasoning, 'Идеальное совпадение по стеку TypeScript');

  const row2 = db
    .select()
    .from(applicationRecords)
    .where(eq(applicationRecords.vacancyId, 'vac-manual-2'))
    .limit(1)
    .get();

  assert.equal(row2, undefined);
  assert.equal(scheduler.countTodayApplications(), 0);
  assert.equal(scheduler.countPendingApprovals(), 1);
});

test('SchedulerService.runAutoBumpResume() calls hhHybrid.bumpResume() and sends telegram notification when bumped', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('AUTO_BUMP_RESUME', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');

  let bumpCalled = false;
  const hhHybrid = createDummyHhHybrid({
    bumpResume: async () => {
      bumpCalled = true;
      return { data: 'bumped', error: null };
    },
  });

  const sentAdminMessages: string[] = [];
  const telegramBot = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    hhHybrid,
    createDummyLlm()
  );
  telegramBot.sendAdminMessage = async (msg: string) => {
    sentAdminMessages.push(msg);
    return { data: true, error: null };
  };

  const scheduler = new SchedulerService(
    configStore,
    db,
    hhHybrid,
    createDummyLlm(),
    telegramBot
  );

  const bumpRes = await scheduler.runAutoBumpResume();
  assert.equal(bumpRes.data, 'bumped');
  assert.equal(bumpCalled, true);
  assert.ok(sentAdminMessages.some((m) => m.includes('⬆️ Ваше резюме успешно поднято в поиске HH')));

  configStore.setAutoBumpResumeEnabled(false);
  bumpCalled = false;
  const disabledRes = await scheduler.runAutoBumpResume();
  assert.equal(disabledRes.data, 'disabled');
  assert.equal(bumpCalled, false);
});

test('ExcelExporterService generates .xlsx containing headers and formats new statuses properly', async () => {
  const { db } = createTestDatabase();
  const now = new Date().toISOString();

  db.insert(applicationRecords).values([
    {
      vacancyId: 'exp-1',
      companyName: 'Pending Corp',
      positionTitle: 'Architect',
      salaryText: '500 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/exp-1',
      coverLetter: 'Письмо 1',
      status: 'pending_approval',
      matchScore: 95,
      aiReasoning: 'Прекрасный профиль',
      isNotified: false,
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'exp-2',
      companyName: 'LowScore Corp',
      positionTitle: 'PHP Dev',
      salaryText: '60 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/exp-2',
      coverLetter: '',
      status: 'skipped_low_score',
      matchScore: 30,
      aiReasoning: 'Низкий балл',
      isNotified: true,
      appliedAt: now,
      updatedAt: now,
    },
    {
      vacancyId: 'exp-3',
      companyName: 'UserSkip Corp',
      positionTitle: 'Junior Dev',
      salaryText: '40 000 руб.',
      vacancyUrl: 'https://hh.ru/vacancy/exp-3',
      coverLetter: 'Письмо 3',
      status: 'skipped_user',
      matchScore: 70,
      aiReasoning: 'Отказ на анкете',
      isNotified: true,
      appliedAt: now,
      updatedAt: now,
    },
  ]).run();

  const exporter = new ExcelExporterService(db);
  const result = await exporter.exportApplicationsReport();

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.rowCount, 3);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(result.data.buffer));
  const sheet = wb.getWorksheet('Отклики HH.ru');
  assert.ok(sheet);

  const headerRow = sheet.getRow(1);
  const headerValues = Array.isArray(headerRow.values) ? headerRow.values : [];
  assert.ok(headerValues.includes('Оценка ИИ (%)'));
  assert.ok(headerValues.includes('Комментарий ИИ'));

  const statusValues: string[] = [];
  const scoreValues: (number | string)[] = [];
  const reasoningValues: string[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      statusValues.push(String(row.getCell(5).value));
      scoreValues.push(row.getCell(6).value as number | string);
      reasoningValues.push(String(row.getCell(7).value));
    }
  });

  assert.ok(statusValues.includes('Ожидает одобрения'));
  assert.ok(statusValues.includes('Пропущено (низкий балл ИИ)'));
  assert.ok(statusValues.includes('Пропущено пользователем'));

  assert.ok(scoreValues.includes(95));
  assert.ok(scoreValues.includes(30));
  assert.ok(scoreValues.includes(70));

  assert.ok(reasoningValues.includes('Прекрасный профиль'));
  assert.ok(reasoningValues.includes('Низкий балл'));
  assert.ok(reasoningValues.includes('Отказ на анкете'));
});
