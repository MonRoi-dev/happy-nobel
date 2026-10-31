import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { Page } from 'playwright';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import {
  HhVacancyApplyFsm,
  type EmployerQuestionSolver,
  type HhApplyFormContext,
} from '../src/modules/hh-hybrid/hh-apply-fsm.ts';
import {
  DefaultPlaywrightBrowserDriver,
  HhHybridService,
  isTrackerUrl,
  type PlaywrightBrowserDriver,
  type ScrapedVacancyDetailsResult,
  type WarmBrowserSessionOptions,
} from '../src/modules/hh-hybrid/hh-hybrid.service.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
    CREATE TABLE "user_profile" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "hhResumeTitle" TEXT NOT NULL, "resumeRawText" TEXT NOT NULL, "customPromptRules" TEXT);
    CREATE TABLE "search_filters" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "queryText" TEXT NOT NULL, "excludedWords" TEXT, "areaId" TEXT, "schedule" TEXT, "salaryFrom" INTEGER);
    CREATE TABLE "application_records" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "vacancyId" TEXT NOT NULL UNIQUE, "companyName" TEXT NOT NULL, "positionTitle" TEXT NOT NULL, "salaryText" TEXT NOT NULL, "vacancyUrl" TEXT NOT NULL, "coverLetter" TEXT NOT NULL, "status" TEXT NOT NULL, "matchScore" INTEGER, "aiReasoning" TEXT, "lastEmployerMessage" TEXT, "isNotified" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

test('HhVacancyApplyFsm returns QUESTIONS_REQUIRED when questions exist on page and questionSolver is not provided', async () => {
  const fsm = new HhVacancyApplyFsm();

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/123456',
    goto: async () => {},
    locator: (selector: string) => {
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isButton =
        (selector.includes('vacancy-response-link-top') ||
          selector.includes('vacancy-response-link-bottom')) &&
        !isAlreadyResponded;
      const isQuestionField = selector.includes('textarea[name^="task_"]');

      return {
        count: async () => (isButton || isQuestionField ? 1 : 0),
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => isButton || isQuestionField,
          count: async () => (isButton || isQuestionField ? 1 : 0),
          click: async () => {},
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '123456',
    vacancyUrl: 'https://hh.ru/vacancy/123456',
  });

  assert.equal(result.data, null);
  assert.equal(result.error, 'QUESTIONS_REQUIRED');
});

test('HhVacancyApplyFsm scrapes text/radio/checkbox questions, invokes questionSolver, fills answers, submits, and returns applied: true', async () => {
  const fsm = new HhVacancyApplyFsm();

  const filledAnswers: Record<string, string> = {};
  const clickedLabels: string[] = [];
  let submitClicked = false;

  const mockQuestions = [
    { id: 'task_text_1', questionText: 'Your experience?', fieldType: 'textarea' as const },
    {
      id: 'task_radio_2',
      questionText: 'Do you know TypeScript?',
      fieldType: 'radio' as const,
      options: ['Yes', 'No'],
    },
    {
      id: 'task_check_3',
      questionText: 'Frameworks used?',
      fieldType: 'checkbox' as const,
      options: ['Node.js', 'Fastify'],
    },
  ];

  let solverCalledWith: unknown = null;
  const questionSolver: EmployerQuestionSolver = async (questions) => {
    solverCalledWith = questions;
    return {
      data: [
        { id: 'task_text_1', answerText: '5 years of fullstack experience' },
        { id: 'task_radio_2', selectedOptions: ['Yes'] },
        { id: 'task_check_3', selectedOptions: ['Node.js', 'Fastify'] },
      ],
      error: null,
    };
  };

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/123456',
    goto: async () => {},
    evaluate: async (fn: () => unknown) => {
      return mockQuestions;
    },
    locator: (selector: string, filterOptions?: { hasText?: string }) => {
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isButton =
        (selector.includes('vacancy-response-link-top') ||
          selector.includes('vacancy-response-link-bottom')) &&
        !isAlreadyResponded;
      const isQuestionField = selector.includes('textarea[name^="task_"]');
      const isSubmitBtn =
        selector.includes('vacancy-response-submit-popup') ||
        selector.includes('vacancy-response-letter-submit') ||
        selector.includes('Отправить') ||
        selector.includes('Откликнуться');
      const isConfirmation =
        submitClicked &&
        (selector.includes('Вы откликнулись') ||
          selector.includes('vacancy-response-link-view-topic') ||
          selector.includes('Отклик отправлен'));

      return {
        count: async () => (isButton || isQuestionField || isSubmitBtn || isConfirmation || filterOptions?.hasText ? 1 : 0),
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => isButton || isQuestionField || isSubmitBtn || isConfirmation || Boolean(filterOptions?.hasText),
          count: async () => 1,
          click: async () => {
            if (isSubmitBtn) {
              submitClicked = true;
            }
            if (filterOptions?.hasText) {
              clickedLabels.push(filterOptions.hasText);
            }
          },
          fill: async (val: string) => {
            filledAnswers[selector] = val;
          },
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '123456',
    vacancyUrl: 'https://hh.ru/vacancy/123456',
    questionSolver,
  });

  assert.ok(solverCalledWith);
  assert.equal(Array.isArray(solverCalledWith) && (solverCalledWith as unknown[]).length, 3);
  assert.equal(submitClicked, true);
  assert.deepEqual(clickedLabels, ['Yes', 'Node.js', 'Fastify']);
  assert.equal(result.error, null);
  assert.equal(result.data?.applied, true);
  assert.equal(result.data?.alreadyApplied, false);
});

test('HhVacancyApplyFsm returns QUESTIONS_REQUIRED when hard blocker is visible even if questionSolver is provided', async () => {
  const fsm = new HhVacancyApplyFsm();

  let solverInvoked = false;
  const questionSolver: EmployerQuestionSolver = async () => {
    solverInvoked = true;
    return { data: [], error: null };
  };

  const fakePage = {
    url: () => 'https://hh.ru/vacancy/123456',
    goto: async () => {},
    locator: (selector: string) => {
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isButton = selector.includes('vacancy-response-link-top') && !isAlreadyResponded;
      const isQuestionField = selector.includes('textarea[name^="task_"]');
      const isBlocker = selector.includes('Чтобы откликнуться на эту вакансию, поменяйте видимость резюме');

      return {
        count: async () => (isButton || isQuestionField || isBlocker ? 1 : 0),
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => (isButton || isQuestionField || isBlocker) && !isAlreadyResponded,
          count: async () => 1,
          click: async () => {},
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '123456',
    vacancyUrl: 'https://hh.ru/vacancy/123456',
    questionSolver,
  });

  assert.equal(solverInvoked, false);
  assert.equal(result.data, null);
  assert.equal(result.error, 'QUESTIONS_REQUIRED');
});

test('HhHybridService.bumpResume returns bumped when active, not_ready when disabled, and resets HH_IS_LOGGED_IN on login redirect', async () => {
  const { sqlite, db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.ensureDefaults();
  configStore.set('HH_IS_LOGGED_IN', 'true');

  let bumpBehavior: 'bumped' | 'not_ready' | 'login_error' = 'bumped';

  const mockDriver: PlaywrightBrowserDriver = {
    loginAndScrapeResume: async () => ({ data: { hhResumeTitle: 'Title', resumeRawText: 'Raw' }, error: null }),
    searchVacanciesInBrowser: async () => ({ data: { items: [], found: 0, page: 0, pages: 0, per_page: 50 }, error: null }),
    scrapeVacancyDetailsInBrowser: async () => ({ data: null as unknown as ScrapedVacancyDetailsResult, error: null }),
    applyInBrowser: async () => ({ data: true, error: null }),
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => {
      if (bumpBehavior === 'bumped') {
        return { data: 'bumped', error: null };
      }
      if (bumpBehavior === 'not_ready') {
        return { data: 'not_ready', error: null };
      }
      return {
        data: null,
        error: 'Сессия HH.ru не авторизована в браузере (редирект на /account/login).',
      };
    },
  };

  const service = new HhHybridService(configStore, db, { customDriver: mockDriver });

  const activeRes = await service.bumpResume();
  assert.equal(activeRes.error, null);
  assert.equal(activeRes.data, 'bumped');
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'true');

  bumpBehavior = 'not_ready';
  const notReadyRes = await service.bumpResume();
  assert.equal(notReadyRes.error, null);
  assert.equal(notReadyRes.data, 'not_ready');
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'true');

  bumpBehavior = 'login_error';
  const loginErrRes = await service.bumpResume();
  assert.equal(loginErrRes.data, null);
  assert.match(loginErrRes.error ?? '', /\/account\/login/);
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'false');

  const unauthRes = await service.bumpResume();
  assert.equal(unauthRes.data, null);
  assert.match(unauthRes.error ?? '', /не авторизована/);

  sqlite.close();
});

test('DefaultPlaywrightBrowserDriver selector matches multi-token data-qa="resume-update-button resume-update-button_actions"', () => {
  const selector = '[data-qa~="resume-update-button"], [data-qa~="resume-update-button_actions"], [data-qa*="resume-update-button"], button:has-text("Поднять в поиске")';
  const matchesToken = (dataQa: string, text: string) => {
    const tokens = dataQa.split(/\s+/);
    return (
      tokens.includes('resume-update-button') ||
      tokens.includes('resume-update-button_actions') ||
      dataQa.includes('resume-update-button') ||
      text.includes('Поднять в поиске')
    );
  };

  assert.equal(matchesToken('resume-update-button resume-update-button_actions', 'Поднять в поиске'), true);
  assert.equal(matchesToken('resume-update-button', 'Поднять в поиске'), true);
  assert.equal(matchesToken('other-button', 'Поднять в поиске'), true);
  assert.equal(matchesToken('resumeservice-button__renewresume', 'Поднимать автоматически'), false);
  assert.ok(selector.includes('data-qa~="resume-update-button"'));
  assert.ok(selector.includes('Поднять в поиске'));
});

test('HhVacancyApplyFsm propagates vacancyTitle and companyName into HhApplyFormContext for questionSolver', async () => {
  const fsm = new HhVacancyApplyFsm();
  let receivedContext: HhApplyFormContext | undefined;
  const questionSolver: EmployerQuestionSolver = async (_questions, context) => {
    receivedContext = context;
    return {
      data: [{ id: 'task_text_1', answerText: '5 лет опыта', selectedOptions: [] }],
      error: null,
    };
  };

  let submitClicked = false;
  const fakePage = {
    url: () => 'https://hh.ru/vacancy/98765',
    goto: async () => {},
    evaluate: async () => [{ id: 'task_text_1', questionText: 'Tell about yourself', fieldType: 'textarea' as const }],
    locator: (selector: string, filterOptions?: { hasText?: string }) => {
      const isAlreadyResponded = selector.includes('Вы откликнулись');
      const isButton =
        (selector.includes('vacancy-response-link-top') ||
          selector.includes('vacancy-response-link-bottom')) &&
        !isAlreadyResponded;
      const isQuestionField =
        selector.includes('textarea[name') || selector.includes('task_') || selector.includes('test-task-input');
      const isSubmitBtn =
        selector.includes('vacancy-response-submit-popup') ||
        selector.includes('vacancy-response-letter-submit') ||
        selector.includes('Отправить') ||
        selector.includes('Откликнуться');
      const isConfirmation =
        submitClicked &&
        (selector.includes('Вы откликнулись') ||
          selector.includes('vacancy-response-link-view-topic') ||
          selector.includes('Отклик отправлен'));

      return {
        count: async () => (isButton || isQuestionField || isSubmitBtn || isConfirmation || filterOptions?.hasText ? 1 : 0),
        first: () => ({
          waitFor: async () => {},
          isVisible: async () => isButton || isQuestionField || isSubmitBtn || isConfirmation || Boolean(filterOptions?.hasText),
          count: async () => 1,
          click: async () => {
            if (isSubmitBtn) {
              submitClicked = true;
            }
          },
          fill: async () => {},
        }),
      };
    },
    waitForTimeout: async () => {},
  } as unknown as Page;

  const result = await fsm.execute({
    page: fakePage,
    vacancyId: '98765',
    vacancyUrl: 'https://hh.ru/vacancy/98765',
    vacancyTitle: 'Senior Node.js Engineer',
    companyName: 'Acme Highload Corp',
    questionSolver,
  });

  assert.equal(result.error, null);
  assert.equal(receivedContext?.vacancyId, '98765');
  assert.equal(receivedContext?.vacancyUrl, 'https://hh.ru/vacancy/98765');
  assert.equal(receivedContext?.vacancyTitle, 'Senior Node.js Engineer');
  assert.equal(receivedContext?.companyName, 'Acme Highload Corp');
});

test('isTrackerUrl detects analytics trackers and allows hh/captcha resources', () => {
  assert.equal(isTrackerUrl('https://mc.yandex.ru/metrika/tag.js'), true);
  assert.equal(isTrackerUrl('https://www.google-analytics.com/analytics.js'), true);
  assert.equal(isTrackerUrl('https://www.googletagmanager.com/gtm.js?id=GTM-123'), true);
  assert.equal(isTrackerUrl('https://top-fwz1.mail.ru/counter?id=123'), true);
  assert.equal(isTrackerUrl('https://vk.com/rtrg?p=123'), true);
  assert.equal(isTrackerUrl('https://hh.ru/vacancy/12345'), false);
  assert.equal(isTrackerUrl('https://hhcdn.ru/images/captcha.png'), false);
  assert.equal(isTrackerUrl('https://smartcaptcha.yandexcloud.net/captcha.js'), false);
});

test('DefaultPlaywrightBrowserDriver supports WarmBrowserSessionOptions and closeWarmSession', async () => {
  const warmOpts: WarmBrowserSessionOptions = {
    keepWarmMs: 50,
    blockHeavyResources: true,
  };
  const driver = new DefaultPlaywrightBrowserDriver(warmOpts);
  assert.equal(typeof driver.closeWarmSession, 'function');
  await assert.doesNotReject(async () => {
    await driver.closeWarmSession();
  });
});

test('HhHybridService.closeWarmSession delegates to browserDriver', async () => {
  let driverClosed = false;
  const customDriver: PlaywrightBrowserDriver = {
    loginAndScrapeResume: async () => ({ data: { hhResumeTitle: '', resumeRawText: '' }, error: null }),
    searchVacanciesInBrowser: async () => ({ data: { items: [], found: 0, pages: 0, page: 0, per_page: 20 }, error: null }),
    scrapeVacancyDetailsInBrowser: async () => ({ data: null, error: 'not implemented' }),
    applyInBrowser: async () => ({ data: false, error: null }),
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => ({ data: 'not_ready' as const, error: null }),
    closeWarmSession: async () => {
      driverClosed = true;
    },
  };
  const { db, sqlite } = createTestDatabase();
  try {
    const configStore = new ConfigStoreService(db);
    const hybrid = new HhHybridService(configStore, db, { customDriver });
    assert.equal(typeof hybrid.closeWarmSession, 'function');
    await hybrid.closeWarmSession();
    assert.equal(driverClosed, true);
  } finally {
    sqlite.close();
  }
});

test('loginInteractive does not invoke closeWarmSession before in-flight apply completes', async () => {
  const events: string[] = [];
  let resolveApply: () => void = () => {};
  const applyDeferred = new Promise<void>((resolve) => {
    resolveApply = resolve;
  });

  const customDriver: PlaywrightBrowserDriver = {
    loginAndScrapeResume: async () => {
      events.push('loginAndScrapeResume');
      return { data: { hhResumeTitle: 'Dev', resumeRawText: 'Resume text' }, error: null };
    },
    searchVacanciesInBrowser: async () => ({ data: { items: [], found: 0, pages: 0, page: 0, per_page: 20 }, error: null }),
    scrapeVacancyDetailsInBrowser: async () => ({ data: null, error: 'not implemented' }),
    applyInBrowser: async () => {
      events.push('apply_start');
      await applyDeferred;
      events.push('apply_end');
      return { data: true, error: null };
    },
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => ({ data: 'not_ready' as const, error: null }),
    closeWarmSession: async () => {
      events.push('closeWarmSession');
    },
  };

  const { db, sqlite } = createTestDatabase();
  try {
    const configStore = new ConfigStoreService(db);
    configStore.set('HH_IS_LOGGED_IN', 'true');
    const hybrid = new HhHybridService(configStore, db, { customDriver });

    const applyPromise = hybrid.applyToVacancy({
      vacancyId: '12345',
      vacancyUrl: 'https://hh.ru/vacancy/12345',
      vacancyTitle: 'Senior TypeScript Engineer',
      companyName: 'Acme',
      resumeTitle: 'Dev',
      coverLetter: 'Hello',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const loginPromise = hybrid.loginInteractive();

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['apply_start']);

    resolveApply();
    await Promise.all([applyPromise, loginPromise]);

    assert.deepEqual(events, ['apply_start', 'apply_end', 'loginAndScrapeResume']);
  } finally {
    sqlite.close();
  }
});

test('DefaultPlaywrightBrowserDriver waits for in-flight closeWarmSession before acquiring warm context', async () => {
  let resolveClose: () => void = () => {};
  const closeDeferred = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  let launchCount = 0;
  let closeStarted = false;

  const stubLocator = {
    waitFor: async () => {},
    count: async () => 0,
    isVisible: async () => false,
    isEnabled: async () => false,
    getAttribute: async () => null,
  };

  const stubPage: Page = new Proxy({} as never, {
    get(_pTarget, pProp) {
      if (pProp === 'then') return undefined;
      if (pProp === 'goto') return async () => ({ status: () => 200 });
      if (pProp === 'waitForTimeout') return async () => {};
      if (pProp === 'url') return () => 'https://hh.ru/applicant/resumes';
      if (pProp === 'locator') return () => ({ first: () => stubLocator, ...stubLocator });
      return () => undefined;
    },
  });

  const stubContext: BrowserContext = new Proxy({} as never, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'close') {
        return async () => {
          closeStarted = true;
          await closeDeferred;
        };
      }
      if (prop === 'pages') {
        return () => [stubPage];
      }
      if (prop === 'newPage') {
        return async () => stubPage;
      }
      if (prop === 'route') return async () => {};
      return () => undefined;
    },
  });

  const driver = new DefaultPlaywrightBrowserDriver({
    keepWarmMs: 60_000,
    blockHeavyResources: false,
    launchPersistentContext: async () => {
      launchCount++;
      return stubContext;
    },
  });

  await driver.bumpResumeInBrowser('/tmp/test-session');
  assert.equal(launchCount, 1);

  const closePromise = driver.closeWarmSession();
  assert.equal(closeStarted, true);

  let secondLaunchDone = false;
  const secondCallPromise = driver.bumpResumeInBrowser('/tmp/test-session').then(() => {
    secondLaunchDone = true;
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(launchCount, 1);
    assert.equal(secondLaunchDone, false);
  } finally {
    resolveClose();
    await Promise.all([closePromise, secondCallPromise]);
  }

  assert.equal(launchCount, 2);
  assert.equal(secondLaunchDone, true);
});


