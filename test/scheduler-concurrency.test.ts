import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { searchFilters, userProfiles } from '../src/db/schema.ts';
import { ConfigStoreService } from '../src/modules/config-store/index.ts';
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

test('toggle off then on during in-flight evaluation does not start concurrent cycle', async () => {
  const { db, sqlite } = createTestDatabase();
  try {
    const configStore = new ConfigStoreService(db);
    configStore.ensureDefaults();
    configStore.set('AUTO_APPLY_ENABLED', 'true');
    configStore.set('HH_IS_LOGGED_IN', 'true');

    db.insert(userProfiles).values({
      hhResumeTitle: 'Senior TypeScript Engineer',
      resumeRawText: 'Experienced Node.js and TypeScript developer with 6 years experience',
      customPromptRules: null,
    }).run();

    db.insert(searchFilters).values({
      queryText: 'Node.js',
      excludedWords: null,
      areaId: null,
      schedule: null,
      salaryFrom: null,
    }).run();

    let resolveEval: () => void = () => {};
    const evalDeferred = new Promise<void>((resolve) => {
      resolveEval = resolve;
    });

    let searchCalls = 0;
    const hhHybrid = {
      loginInteractive: async () => ({ data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' }, error: null }),
      searchVacancies: async () => {
        searchCalls++;
        return {
          data: {
            items: [
              {
                id: 'vac-concurrent-1',
                name: 'Senior Node.js Developer',
                employer: { name: 'Acme Corp' },
                alternate_url: 'https://hh.ru/vacancy/vac-concurrent-1',
                apply_alternate_url: 'https://hh.ru/applicant/vacancy_response?vacancyId=vac-concurrent-1',
                has_test: false,
                response_letter_required: false,
                archived: false,
              },
            ],
            found: 1,
            pages: 1,
            page: 0,
            perPage: 20,
          },
          error: null,
        };
      },
      getVacancyDetails: async (id = 'vac-concurrent-1') => ({
        data: {
          vacancy: {
            id,
            name: 'Senior Node.js Developer',
            description: 'Detailed description of the requirement',
            alternate_url: `https://hh.ru/vacancy/${id}`,
            archived: false,
            has_test: false,
            response_letter_required: false,
            salary: null,
            employer: { name: 'Acme Corp' },
            key_skills: [],
          },
          cleanDescription: 'Detailed description of the requirement',
          salaryText: '100 000 руб.',
          vacancyId: id,
          title: 'Senior Node.js Developer',
          companyName: 'Acme Corp',
          salary: '100000',
          employerQuestions: [],
          rawHtml: '',
        } as never,
        error: null,
      }),
      applyToVacancy: async () => ({ data: true, error: null }),
      syncNegotiations: async () => ({ data: { checkedCount: 0, updatedCount: 0, updatedRecords: [] }, error: null }),
      bumpResume: async () => ({ data: 'bumped' as const, error: null }),
    };

    let evalStarted = false;
    const llm = {
      generateCoverLetter: async () => ({ data: 'Cover letter', error: null }),
      evaluateVacancy: async () => {
        evalStarted = true;
        await evalDeferred;
        return {
          data: { matchScore: 90, reasoning: 'Strong match', coverLetter: 'Letter' },
          error: null,
        };
      },
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
    };

    const botService = new TelegramBotService(
      '123456789:ABCDEF12345678901234567890123456789',
      configStore,
      db,
      hhHybrid,
      llm
    );

    const scheduler = new SchedulerService(configStore, db, hhHybrid, llm, botService, {
      minDelayMs: 0,
      maxDelayMs: 0,
      customSleep: async () => {},
    });

    const cyclePromise = scheduler.runAutoApplyCycle();

    while (!evalStarted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(searchCalls, 1);

    await scheduler.handleAutoApplyToggled(false);
    await scheduler.handleAutoApplyToggled(true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    try {
      assert.equal(searchCalls, 1);
    } finally {
      resolveEval();
      await cyclePromise;
    }
  } finally {
    sqlite.close();
  }
});
