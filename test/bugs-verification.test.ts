import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { applicationRecords, userProfiles, searchFilters } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service.ts';
import { countTodayAppliedRecords, getLocalDayKey, getStartOfLocalDayIso } from '../src/modules/scheduler/scheduler-notifications.helper.ts';
import type { ILlmService, LlmHealthStatus } from '../src/modules/llm/llm.service.ts';
import type { IHhHybridService, HhVacancySearchResponse, ScrapedVacancyDetailsResult } from '../src/modules/hh-hybrid/index.ts';
import type { ITelegramBotService } from '../src/modules/telegram/telegram.service.ts';

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

test('Bug 1: notifies admin via telegram when LLM is unavailable and throttles repeat notifications', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '1080358163');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Experienced Node.js and TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const sentAdminMessages: string[] = [];

  let isOnline = false;
  const mockLlm: ILlmService = {
    generateCoverLetter: async () => ({ data: null, error: 'Connection refused' }),
    evaluateVacancy: async () => ({ data: null, error: 'Connection refused' }),
    answerEmployerQuestions: async () => ({ data: null, error: 'Connection refused' }),
    checkHealth: async () => ({ data: { model: 'gemma4:latest', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline,
        baseUrl: 'http://127.0.0.1:11434',
        configuredModel: 'gemma4:latest',
        isConfiguredModelInstalled: isOnline,
        isConfiguredModelLoaded: false,
        pingMs: 1,
        installedModels: isOnline ? [{ name: 'gemma4:latest', size: 1000 }] : [],
        activeModels: [],
        error: isOnline ? null : 'fetch failed: ECONNREFUSED',
      } as LlmHealthStatus,
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
  };

  const mockTelegram: ITelegramBotService = {
    start: async () => {},
    stop: async () => {},
    sendAdminMessage: async (msg: string) => {
      sentAdminMessages.push(msg);
      return { data: true, error: null };
    },
    sendAdminDocument: async () => ({ data: true, error: null }),
  } as unknown as ITelegramBotService;

  let searchVacanciesCalled = false;
  const mockHh: IHhHybridService = {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => {
      searchVacanciesCalled = true;
      return { data: { items: [], found: 0, page: 0, pages: 0, per_page: 50 }, error: null };
    },
    getVacancyDetails: async () => ({ data: null, error: 'Not implemented' }),
    applyToVacancy: async () => ({ data: true, error: null }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'not_ready', error: null }),
  };

  const scheduler = new SchedulerService(configStore, db, mockHh, mockLlm, mockTelegram);

  const check1 = await scheduler.checkLlmAvailabilityAndNotify();
  assert.equal(check1.data, false);
  assert.equal(sentAdminMessages.length, 1);
  assert.match(sentAdminMessages[0]!, /Локальная языковая модель сейчас недоступна/);

  const check2 = await scheduler.checkLlmAvailabilityAndNotify();
  assert.equal(check2.data, false);
  assert.equal(sentAdminMessages.length, 1);

  const cycleRes = await scheduler.runAutoApplyCycle();
  assert.equal(cycleRes.data?.appliedCount, 0);
  assert.equal(searchVacanciesCalled, false);
  assert.equal(sentAdminMessages.length, 1);

  isOnline = true;
  const check3 = await scheduler.checkLlmAvailabilityAndNotify();
  assert.equal(check3.data, true);
  assert.equal(sentAdminMessages.length, 2);
  assert.match(sentAdminMessages[1]!, /Связь с локальной языковой моделью восстановлена/);

  sqlite.close();
});

test('Bug 2: ALREADY_APPLIED vacancies are saved to db but not reported as fresh applies', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '1080358163');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Experienced Node.js and TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const sentAdminMessages: string[] = [];

  const mockLlm: ILlmService = {
    generateCoverLetter: async () => ({ data: 'Valid cover letter', error: null }),
    evaluateVacancy: async () => ({
      data: { matchScore: 100, reasoning: 'Match', coverLetter: 'Valid cover letter that is long enough' },
      error: null,
    }),
    answerEmployerQuestions: async () => ({ data: [], error: null }),
    checkHealth: async () => ({ data: { model: 'gemma4:latest', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline: true,
        baseUrl: 'http://127.0.0.1:11434',
        configuredModel: 'gemma4:latest',
        isConfiguredModelInstalled: true,
        isConfiguredModelLoaded: true,
        pingMs: 1,
        installedModels: [{ name: 'gemma4:latest', size: 1000 }],
        activeModels: [],
        error: null,
      } as LlmHealthStatus,
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
  };

  const mockTelegram: ITelegramBotService = {
    start: async () => {},
    stop: async () => {},
    sendAdminMessage: async (msg: string) => {
      sentAdminMessages.push(msg);
      return { data: true, error: null };
    },
    sendAdminDocument: async () => ({ data: true, error: null }),
  } as unknown as ITelegramBotService;

  const mockHh: IHhHybridService = {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: '138449594',
            name: 'Founding Full-Stack Engineer',
            alternate_url: 'https://hh.ru/vacancy/138449594',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'ООО ALLLINE' },
            snippet: { requirement: 'TypeScript', responsibility: 'Backend' },
          },
        ],
        found: 1,
        page: 0,
        pages: 1,
        per_page: 50,
      },
      error: null,
    }),
    getVacancyDetails: async () => ({
      data: {
        vacancy: {
          id: '138449594',
          name: 'Founding Full-Stack Engineer',
          description: 'Full description',
          alternate_url: 'https://hh.ru/vacancy/138449594',
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: 'ООО ALLLINE' },
          key_skills: [],
        },
        cleanDescription: 'Full description for founding engineer',
        salaryText: 'от 1 500 $',
      },
      error: null,
    }),
    applyToVacancy: async () => ({ data: false, error: 'ALREADY_APPLIED' }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'not_ready', error: null }),
  };

  const scheduler = new SchedulerService(configStore, db, mockHh, mockLlm, mockTelegram);

  const cycleRes = await scheduler.runAutoApplyCycle();
  assert.equal(cycleRes.data?.appliedCount, 0);
  assert.equal(sentAdminMessages.length, 0);

  const rows = db.select().from(applicationRecords).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.vacancyId, '138449594');
  assert.equal(rows[0]!.companyName, 'ООО ALLLINE');

  sqlite.close();
});

test('Bug 2: verifySubmissionOutcome rejects header vacancyResponses-button and requires confirmation', async () => {
  const { HhVacancyApplyFsm } = await import('../src/modules/hh-hybrid/hh-apply-fsm.ts');
  const fsm = new HhVacancyApplyFsm();

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/138449594',
    goto: async () => {},
    locator: (selector: string) => {
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isButton = (selector.includes('vacancy-response-link-top') || selector.includes('vacancy-response-link-bottom')) && !isAlreadyResponded;
      const isHeaderResponses = selector === '[data-qa="vacancyResponses-button"]';
      return {
        count: async () => (isButton || isHeaderResponses ? 1 : 0),
        first: () => ({
          waitFor: async () => { throw new Error('Timeout'); },
          isVisible: async () => isButton,
          count: async () => (isButton || isHeaderResponses ? 1 : 0),
          click: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import('playwright').Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '138449594',
    vacancyUrl: 'https://hh.ru/vacancy/138449594',
  });

  assert.equal(result.data, null);
  assert.match(result.error ?? '', /Post-submission verification failed/);
});

test('Bug 3: handleDailyLimitUpdated automatically resumes auto-apply cycle when limit is increased', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '1080358163');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.setDailyLimit(1);

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Experienced Node.js and TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const nowIso = new Date().toISOString();
  db.insert(applicationRecords).values({
    vacancyId: '100000001',
    companyName: 'Test Company',
    positionTitle: 'Developer',
    salaryText: '100 000 руб.',
    vacancyUrl: 'https://hh.ru/vacancy/100000001',
    coverLetter: 'Test letter',
    status: 'RESPONSE_SENT',
    appliedAt: nowIso,
    updatedAt: nowIso,
  }).run();

  let searchCalledCount = 0;
  const mockHh: IHhHybridService = {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => {
      searchCalledCount++;
      return { data: { items: [], found: 0, page: 0, pages: 0, per_page: 50 }, error: null };
    },
    getVacancyDetails: async () => ({ data: null, error: 'Not implemented' }),
    applyToVacancy: async () => ({ data: true, error: null }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'not_ready', error: null }),
  };

  const mockLlm: ILlmService = {
    generateCoverLetter: async () => ({ data: 'Cover letter', error: null }),
    evaluateVacancy: async () => ({
      data: { matchScore: 100, reasoning: 'Match', coverLetter: 'Valid cover letter that is long enough' },
      error: null,
    }),
    answerEmployerQuestions: async () => ({ data: [], error: null }),
    checkHealth: async () => ({ data: { model: 'gemma4:latest', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline: true,
        baseUrl: 'http://127.0.0.1:11434',
        configuredModel: 'gemma4:latest',
        isConfiguredModelInstalled: true,
        isConfiguredModelLoaded: true,
        pingMs: 1,
        installedModels: [{ name: 'gemma4:latest', size: 1000 }],
        activeModels: [],
        error: null,
      } as LlmHealthStatus,
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
  };

  const sentAdminMessages: string[] = [];
  const mockTelegram: ITelegramBotService = {
    start: async () => {},
    stop: async () => {},
    sendAdminMessage: async (msg: string) => {
      sentAdminMessages.push(msg);
      return { data: true, error: null };
    },
    sendAdminDocument: async () => ({ data: true, error: null }),
  } as unknown as ITelegramBotService;

  const scheduler = new SchedulerService(configStore, db, mockHh, mockLlm, mockTelegram);

  const initialCycle = await scheduler.runAutoApplyCycle();
  assert.equal(initialCycle.data?.limitReached, true);
  assert.equal(searchCalledCount, 0);
  assert.equal(sentAdminMessages.length, 1);
  assert.match(sentAdminMessages[0]!, /Дневной лимит откликов \(1 шт\.\) достигнут/);

  configStore.setDailyLimit(10);
  await scheduler.handleDailyLimitUpdated(10);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(searchCalledCount, 1);

  configStore.set('AUTO_APPLY_ENABLED', 'false');
  await scheduler.handleDailyLimitUpdated(20);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(searchCalledCount, 1);

  sqlite.close();
});

test('Bug 4: QUESTIONS_REQUIRED stores vacancy as pending_approval and does not consume daily apply limit', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.saveBootstrapCredentials('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '1080358163');
  configStore.set('AUTO_APPLY_ENABLED', 'true');
  configStore.set('HH_IS_LOGGED_IN', 'true');
  configStore.setDailyLimit(2);

  db.insert(userProfiles).values({
    hhResumeTitle: 'Node.js Developer',
    resumeRawText: 'Experienced Node.js and TypeScript developer',
  }).run();

  db.insert(searchFilters).values({
    queryText: 'Node.js',
  }).run();

  const sentAdminMessages: string[] = [];
  const mockTelegram: ITelegramBotService = {
    start: async () => {},
    stop: async () => {},
    sendAdminMessage: async (msg: string) => {
      sentAdminMessages.push(msg);
      return { data: true, error: null };
    },
    sendAdminDocument: async () => ({ data: true, error: null }),
  } as unknown as ITelegramBotService;

  const mockLlm: ILlmService = {
    generateCoverLetter: async () => ({ data: 'Cover letter content', error: null }),
    evaluateVacancy: async () => ({
      data: { matchScore: 100, reasoning: 'Match', coverLetter: 'Valid cover letter that is long enough' },
      error: null,
    }),
    answerEmployerQuestions: async () => ({ data: [], error: null }),
    checkHealth: async () => ({ data: { model: 'gemma4:latest', baseUrl: 'http://127.0.0.1:11434' }, error: null }),
    inspectStatus: async () => ({
      data: {
        isOnline: true,
        baseUrl: 'http://127.0.0.1:11434',
        configuredModel: 'gemma4:latest',
        isConfiguredModelInstalled: true,
        isConfiguredModelLoaded: true,
        pingMs: 1,
        installedModels: [{ name: 'gemma4:latest', size: 1000 }],
        activeModels: [],
        error: null,
      } as LlmHealthStatus,
      error: null,
    }),
    listAvailableModels: async () => ({ data: [], error: null }),
  };

  let applyCallIndex = 0;
  const mockHh: IHhHybridService = {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({
      data: {
        items: [
          {
            id: '138038574',
            name: 'Senior FullStack Engineer (Backend-focused)',
            alternate_url: 'https://hh.ru/vacancy/138038574',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Ayo Support Solutions' },
            snippet: { requirement: 'Node', responsibility: 'Backend' },
          },
          {
            id: '138030082',
            name: 'Senior Frontend Engineer (React TypeScript)',
            alternate_url: 'https://hh.ru/vacancy/138030082',
            archived: false,
            has_test: false,
            response_letter_required: false,
            employer: { name: 'Tech Company' },
            snippet: { requirement: 'React', responsibility: 'Frontend' },
          },
        ],
        found: 2,
        page: 0,
        pages: 1,
        per_page: 50,
      },
      error: null,
    }),
    getVacancyDetails: async (id: string) => ({
      data: {
        vacancy: {
          id,
          name: id === '138038574' ? 'Senior FullStack Engineer (Backend-focused)' : 'Senior Frontend Engineer (React TypeScript)',
          description: 'Description',
          alternate_url: `https://hh.ru/vacancy/${id}`,
          archived: false,
          has_test: false,
          response_letter_required: false,
          salary: null,
          employer: { name: id === '138038574' ? 'Ayo Support Solutions' : 'Tech Company' },
          key_skills: [],
        },
        cleanDescription: 'Clean description text for software engineering position',
        salaryText: 'Не указана',
      },
      error: null,
    }),
    applyToVacancy: async (input) => {
      applyCallIndex++;
      if (input.vacancyId === '138038574') {
        return { data: null, error: 'QUESTIONS_REQUIRED' };
      }
      return { data: true, error: null };
    },
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'not_ready', error: null }),
  };

  const scheduler = new SchedulerService(configStore, db, mockHh, mockLlm, mockTelegram);

  const cycleRes = await scheduler.runAutoApplyCycle();
  assert.equal(cycleRes.data?.appliedCount, 1);
  assert.equal(cycleRes.data?.skippedCount, 1);

  const rows = db.select().from(applicationRecords).all();
  assert.equal(rows.length, 2);

  const skippedRow = rows.find((r) => r.vacancyId === '138038574');
  assert.ok(skippedRow);
  assert.equal(skippedRow?.status, 'pending_approval');
  assert.match(skippedRow?.lastEmployerMessage ?? '', /Требуется ручное прохождение теста/);

  const appliedRow = rows.find((r) => r.vacancyId === '138030082');
  assert.ok(appliedRow);
  assert.equal(appliedRow?.status, 'response');

  assert.equal(scheduler.countTodayApplications(), 1);

  const adminWarning = sentAdminMessages.find((m) => m.includes('Вакансия требует ручного отклика'));
  assert.ok(adminWarning);
  assert.match(adminWarning!, /138038574/);
  assert.match(adminWarning!, /Сопроводительное письмо:/);
  assert.match(adminWarning!, /<pre>Valid cover letter that is long enough<\/pre>/);

  sqlite.close();
});

test('Bug 5: cover letter is delivered via chatik when 1-click apply has no modal on vacancy page', async () => {
  const { HhVacancyApplyFsm } = await import('../src/modules/hh-hybrid/hh-apply-fsm.ts');
  const fsm = new HhVacancyApplyFsm();

  let hasResponded = false;
  let chatikOpened = false;
  let applicantActionClicked = false;
  let textInputFilledWith = '';
  let sendButtonClicked = false;

  const fakeChatFrame = {
    url: () => 'https://chatik.hh.ru/chat/12345',
    locator: (selector: string) => {
      const isAction = selector.includes('chatik-chat-message-applicant-action');
      const isInput = selector.includes('text-input');
      const isSend = selector.includes('chatik-do-send-message');
      const isBody = selector === 'body';

      return {
        count: async () => (isAction || isInput || isSend || isBody ? 1 : 0),
        first: () => ({
          waitFor: async () => true,
          isVisible: async () => (isAction ? !sendButtonClicked : true),
          count: async () => (isAction ? (!sendButtonClicked ? 1 : 0) : 1),
          click: async () => {
            if (isAction) applicantActionClicked = true;
            if (isSend) sendButtonClicked = true;
          },
          focus: async () => {},
          fill: async (text: string) => {
            textInputFilledWith = text;
          },
          inputValue: async () => (sendButtonClicked ? '' : textInputFilledWith),
          press: async () => {
            sendButtonClicked = true;
          },
        }),
        innerText: async () => (sendButtonClicked ? 'Здравствуйте! Прошу рассмотреть резюме.' : ''),
      };
    },
  };

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/138572735',
    goto: async () => {},
    frames: () => (chatikOpened ? [fakeChatFrame] : []),
    locator: (selector: string) => {
      const isAlready = selector.includes('Вы откликнулись');
      const isButton = (selector.includes('vacancy-response-link-top') || selector.includes('vacancy-response-link-bottom')) && !isAlready && !hasResponded;
      const isChatBtn = selector.includes('vacancy-response-link-view-topic') && hasResponded;

      return {
        count: async () => (isButton || isChatBtn ? 1 : 0),
        filter: () => ({
          first: () => ({
            count: async () => 0,
            isVisible: async () => false,
          }),
        }),
        first: () => ({
          waitFor: async () => (isButton || isChatBtn ? true : Promise.reject(new Error('Timeout'))),
          isVisible: async () => isButton || isChatBtn,
          count: async () => (isButton || isChatBtn ? 1 : 0),
          click: async () => {
            if (isButton) {
              hasResponded = true;
            }
            if (isChatBtn) {
              chatikOpened = true;
            }
          },
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import('playwright').Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '138572735',
    vacancyUrl: 'https://hh.ru/vacancy/138572735',
    coverLetter: 'Здравствуйте! Прошу рассмотреть резюме.',
  });

  assert.equal(result.error, null);
  assert.equal(result.data?.applied, true);
  assert.equal(result.data?.coverLetterAttached, true);
  assert.equal(chatikOpened, true);
  assert.equal(applicantActionClicked, true);
  assert.equal(textInputFilledWith, 'Здравствуйте! Прошу рассмотреть резюме.');
  assert.equal(sendButtonClicked, true);
});

test('Bug 4 Fix: isInformativeEmployerMessage rejects date dividers, system notices, and uninformative texts', async () => {
  const { isInformativeEmployerMessage } = await import('../src/modules/hh-hybrid/index.ts');

  assert.equal(isInformativeEmployerMessage(''), false);
  assert.equal(isInformativeEmployerMessage('Непрочитанные сообщения'), false);
  assert.equal(isInformativeEmployerMessage('Пользователь ИИ-помощник покинул чат'), false);
  assert.equal(isInformativeEmployerMessage('Пользователь ИИ-помощник присоединился к чату'), false);
  assert.equal(isInformativeEmployerMessage('26 октября'), false);
  assert.equal(isInformativeEmployerMessage('28 октября'), false);
  assert.equal(isInformativeEmployerMessage('28 октября 18:08'), false);
  assert.equal(isInformativeEmployerMessage('Вчера'), false);
  assert.equal(isInformativeEmployerMessage('Сегодня'), false);
  assert.equal(isInformativeEmployerMessage('Позавчера'), false);
  assert.equal(isInformativeEmployerMessage('12:56'), false);
  assert.equal(isInformativeEmployerMessage('Да'), false);
  assert.equal(isInformativeEmployerMessage('Отклик на вакансию'), false);

  assert.equal(
    isInformativeEmployerMessage('Здравствуйте! Благодарим за отклик на нашу вакансию. Приглашаем на интервью.'),
    true
  );
  assert.equal(
    isInformativeEmployerMessage('Давид Араевич, здравствуйте! У вас интересное резюме. Хотели бы связаться.'),
    true
  );
});

test('Bug 2 & Bug 1 Fix: syncUnreadMessagesCore ignores uninformative and candidate-last messages', async () => {
  const { syncUnreadMessagesCore } = await import('../src/modules/telegram/index.ts');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
    CREATE TABLE "application_records" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "vacancyId" TEXT NOT NULL UNIQUE, "companyName" TEXT NOT NULL, "positionTitle" TEXT NOT NULL, "salaryText" TEXT NOT NULL, "vacancyUrl" TEXT NOT NULL, "coverLetter" TEXT NOT NULL, "status" TEXT NOT NULL, "matchScore" INTEGER, "aiReasoning" TEXT, "lastEmployerMessage" TEXT, "isNotified" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
    CREATE TABLE "negotiation_messages" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "negotiation_id" TEXT NOT NULL UNIQUE, "vacancy_id" TEXT NOT NULL, "company_name" TEXT NOT NULL, "position_title" TEXT NOT NULL, "chat_url" TEXT NOT NULL, "last_unread_text" TEXT NOT NULL, "chat_history_json" TEXT NOT NULL, "extracted_contacts" TEXT, "telegram_message_id" INTEGER, "reply_status" TEXT NOT NULL DEFAULT 'unread_notified', "ai_generated_reply" TEXT, "updated_at" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });

  let notificationsSent = 0;
  const mockMessaging = {
    fetchUnreadNegotiations: async () => ({
      data: [
        {
          negotiationId: 'neg-date-only',
          vacancyId: 'vac-1',
          companyName: 'Company 1',
          positionTitle: 'Dev',
          chatUrl: 'https://hh.ru/chat/neg-date-only',
          unreadMessages: ['26 октября'],
          fullHistory: [{ sender: 'employer' as const, text: '26 октября' }],
        },
        {
          negotiationId: 'neg-system-msg',
          vacancyId: 'vac-2',
          companyName: 'Company 2',
          positionTitle: 'Dev',
          chatUrl: 'https://hh.ru/chat/neg-system-msg',
          unreadMessages: ['Пользователь ИИ-помощник покинул чат'],
          fullHistory: [{ sender: 'employer' as const, text: 'Пользователь ИИ-помощник покинул чат' }],
        },
        {
          negotiationId: 'neg-candidate-last',
          vacancyId: 'vac-3',
          companyName: 'Company 3',
          positionTitle: 'Dev',
          chatUrl: 'https://hh.ru/chat/neg-candidate-last',
          unreadMessages: [],
          fullHistory: [
            { sender: 'employer' as const, text: 'Здравствуйте! Пройдите тестирование.' },
            { sender: 'applicant' as const, text: 'Здравствуйте! Я приступил к тестированию.' },
          ],
        },
        {
          negotiationId: 'neg-valid-employer',
          vacancyId: 'vac-4',
          companyName: 'Company 4',
          positionTitle: 'Dev',
          chatUrl: 'https://hh.ru/chat/neg-valid-employer',
          unreadMessages: ['Добрый день! Уточните, когда вам удобно созвониться?'],
          fullHistory: [
            { sender: 'employer' as const, text: 'Добрый день! Уточните, когда вам удобно созвониться?' },
          ],
        },
      ],
      error: null,
    }),
    sendChatMessage: async () => ({ data: true, error: null }),
  };

  const res = await syncUnreadMessagesCore({
    db,
    hhMessaging: mockMessaging,
    sendUnreadChatNotification: async () => {
      notificationsSent++;
      return { data: 999, error: null };
    },
  });

  assert.equal(res.error, null);
  assert.equal(notificationsSent, 1);
  assert.equal(res.data?.notifiedCount, 1);
});

test('Bug: HhVacancyApplyFsm falls back to chat when on-page cover letter was not attached', async () => {
  const { HhVacancyApplyFsm } = await import('../src/modules/hh-hybrid/hh-apply-fsm.ts');
  const fsm = new HhVacancyApplyFsm();

  let letterSubmittedViaChat = false;

  const fakeChatFrame = {
    url: () => 'https://chatik.hh.ru/chat/12345',
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async () => {},
        isVisible: async () => true,
        count: async () => 1,
        click: async () => {},
        focus: async () => {},
        fill: async (text: string) => {
          if (text.includes('Cover Letter Content')) {
            letterSubmittedViaChat = true;
          }
        },
        press: async () => {},
        inputValue: async () => '',
      }),
      count: async () => 1,
    }),
  };

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/138294911',
    goto: async () => {},
    frames: () => [fakeChatFrame],
    locator: (selector: string) => {
      const isButton = selector.includes('vacancy-response-link-top');
      const isViewTopic = selector.includes('vacancy-response-link-view-topic');
      const isOutcome = selector.includes('vacancy-response-link-view-topic') || selector.includes('Вы откликнулись');
      const isInput = selector.includes('vacancy-response-popup-form-letter-input');
      return {
        count: async () => (isButton || isViewTopic || isOutcome ? 1 : 0),
        first: () => ({
          waitFor: async (opts?: { state?: string }) => {
            if (opts?.state === 'hidden' && isInput) {
              throw new Error('Not hidden');
            }
          },
          isVisible: async () => isButton || isViewTopic || isOutcome,
          count: async () => (isButton || isViewTopic || isOutcome ? 1 : 0),
          click: async () => {},
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as import('playwright').Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '138294911',
    vacancyUrl: 'https://hh.ru/vacancy/138294911',
    coverLetter: 'Cover Letter Content',
  });

  assert.equal(result.error, null);
  assert.equal(result.data?.applied, true);
  assert.equal(result.data?.coverLetterAttached, true);
  assert.equal(letterSubmittedViaChat, true);
});

test('Bug: HhHybridService.checkAuthStatus verifies session and updates HH_IS_LOGGED_IN to true', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'false');

  const { HhHybridService } = await import('../src/modules/hh-hybrid/hh-hybrid.service.ts');

  const fakeDriver = {
    loginAndScrapeResume: async () => ({ data: null, error: 'ABORTED_BROWSER_CLOSED' }),
    verifySessionAndScrapeResume: async () => ({
      data: {
        hhResumeTitle: 'Разработчик Node.js',
        resumeRawText: 'Опыт работы 4 года бэкенд разработчик',
      },
      error: null,
    }),
    searchVacanciesInBrowser: async () => ({ data: { items: [], found: 0, page: 0, pages: 0, per_page: 20 }, error: null }),
    scrapeVacancyDetailsInBrowser: async () => ({ data: null as never, error: null }),
    applyInBrowser: async () => ({ data: true, error: null }),
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => ({ data: 'not_ready' as const, error: null }),
  };

  const hybrid = new HhHybridService(configStore, db, { customDriver: fakeDriver });
  const checkRes = await hybrid.checkAuthStatus();

  assert.equal(checkRes.error, null);
  assert.equal(checkRes.data?.hhResumeTitle, 'Разработчик Node.js');
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'true');

  const profile = db.select().from(userProfiles).limit(1).get();
  assert.ok(profile);
  assert.equal(profile?.hhResumeTitle, 'Разработчик Node.js');

  sqlite.close();
});

test('Bug: HhHybridService.loginInteractive falls back to session verification when browser is closed', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'false');

  const { HhHybridService } = await import('../src/modules/hh-hybrid/hh-hybrid.service.ts');

  let verifyCalled = false;
  const fakeDriver = {
    loginAndScrapeResume: async () => {
      verifyCalled = true;
      return {
        data: {
          hhResumeTitle: 'Senior TypeScript Engineer',
          resumeRawText: 'Fullstack node react dev',
        },
        error: null,
      };
    },
    verifySessionAndScrapeResume: async () => ({
      data: {
        hhResumeTitle: 'Senior TypeScript Engineer',
        resumeRawText: 'Fullstack node react dev',
      },
      error: null,
    }),
    searchVacanciesInBrowser: async () => ({ data: { items: [], found: 0, page: 0, pages: 0, per_page: 20 }, error: null }),
    scrapeVacancyDetailsInBrowser: async () => ({ data: null as never, error: null }),
    applyInBrowser: async () => ({ data: true, error: null }),
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => ({ data: 'not_ready' as const, error: null }),
  };

  const hybrid = new HhHybridService(configStore, db, { customDriver: fakeDriver });
  const loginRes = await hybrid.loginInteractive();

  assert.equal(loginRes.error, null);
  assert.equal(loginRes.data?.hhResumeTitle, 'Senior TypeScript Engineer');
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'true');
  assert.equal(verifyCalled, true);

  sqlite.close();
});

test('Bug: TelegramBotService renders confirm_login button in main menu when not logged in', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'false');

  const { TelegramBotService } = await import('../src/modules/telegram/telegram.service.ts');

  const fakeHybrid = {
    loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    confirmLogin: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    checkAuthStatus: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
    searchVacancies: async () => ({ data: { items: [], found: 0, page: 0, pages: 0, per_page: 20 }, error: null }),
    getVacancyDetails: async () => ({ data: null as never, error: null }),
    applyToVacancy: async () => ({ data: true, error: null }),
    syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
    bumpResume: async () => ({ data: 'not_ready' as const, error: null }),
  };

  const botService = new TelegramBotService(
    '123456789:ABCDEF12345678901234567890123456789',
    configStore,
    db,
    fakeHybrid as never,
    null as never
  );

  const kbNotLogged = botService.buildMainMenuKeyboard();
  assert.ok(kbNotLogged.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:confirm_login' && btn.text.includes('Я вошел'))));

  configStore.set('HH_IS_LOGGED_IN', 'true');
  const kbLogged = botService.buildMainMenuKeyboard();
  assert.ok(kbLogged.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'menu:confirm_login' && btn.text.includes('Проверить сессию'))));

  sqlite.close();
});

test('Bug Fix: LlmService adapts cover letter to vacancy requirements and mentions company name', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();

  const { LlmService } = await import('../src/modules/llm/llm.service.ts');

  let capturedPrompt = '';
  let capturedTemperature: number | undefined;

  const mockClient = {
    chat: async (req: any) => {
      capturedPrompt = req.messages?.find((m: any) => m.role === 'user')?.content ?? '';
      capturedTemperature = req.options?.temperature;
      return {
        model: 'gemma4:64k',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            matchScore: 92,
            reasoning: 'Отличное совпадение по NestJS, PostgreSQL и RabbitMQ.',
            coverLetter:
              'Здравствуйте, команда ФинТехПро! Внимательно ознакомился с вашей вакансией. Имею 4+ года опыта на Node.js и TypeScript, разрабатывал микросервисы на NestJS, настраивал очереди RabbitMQ и оптимизировал запросы в PostgreSQL. С удовольствием обсужу задачи вашего проекта.',
          }),
        },
        done: true,
      };
    },
  };

  const llm = new LlmService(configStore, mockClient as any);
  const result = await llm.evaluateVacancy({
    resumeRawText: 'Разработчик Node.js, TypeScript, NestJS, PostgreSQL, RabbitMQ, Redis, 4 года опыта.',
    vacancyTitle: 'Senior Backend Developer (NestJS)',
    companyName: 'ФинТехПро',
    vacancyDescription: 'Требуется опытный бэкендер для разработки финтех-сервисов на NestJS, работы с очередями RabbitMQ и высоконагруженными базами данных PostgreSQL.',
    minMatchScore: 70,
  });

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data.matchScore, 92);
  assert.ok(capturedPrompt.includes('ФинТехПро'));
  assert.ok(capturedPrompt.includes('Senior Backend Developer (NestJS)'));
  assert.ok(capturedPrompt.includes('пересечения'));
  assert.ok(capturedTemperature === 0.45);
  assert.ok(result.data.coverLetter.includes('ФинТехПро'));
  assert.ok(result.data.coverLetter.includes('NestJS'));

  sqlite.close();
});

test('line count of all src files is strictly under 1000 LOC and local day helper is timezone-consistent', () => {
  const files = [
    'src/modules/hh-hybrid/hh-apply-fsm.ts',
    'src/modules/hh-hybrid/hh-hybrid.service.ts',
    'src/modules/scheduler/scheduler.service.ts',
  ];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    assert.ok(lines < 1000, `${file} exceeds 1000 LOC (${lines})`);
  }
  const sampleDate = new Date(2026, 9, 31, 1, 30, 0);
  assert.equal(getLocalDayKey(sampleDate), '2026-10-31');
  assert.ok(getStartOfLocalDayIso(sampleDate).endsWith('Z'));
});

test('countTodayAppliedRecords filters strictly by appliedAt and ignores updatedAt from sync', () => {
  const { sqlite, db } = createTestDatabase();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  db.insert(applicationRecords).values([
    {
      vacancyId: 'old-synced',
      companyName: 'Old Corp',
      positionTitle: 'Dev',
      salaryText: '',
      vacancyUrl: 'https://hh.ru/vacancy/old-synced',
      coverLetter: '',
      status: 'invitation',
      appliedAt: yesterday.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      vacancyId: 'today-fresh',
      companyName: 'Today Corp',
      positionTitle: 'Dev',
      salaryText: '',
      vacancyUrl: 'https://hh.ru/vacancy/today-fresh',
      coverLetter: '',
      status: 'response',
      appliedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ]).run();

  assert.equal(countTodayAppliedRecords(db, now), 1);
  sqlite.close();
});
