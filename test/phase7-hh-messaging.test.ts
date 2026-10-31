import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import { syncUnreadMessagesCore } from '../src/modules/telegram/index.ts';
import { AgentLoggerService } from '../src/modules/logger/agent-logger.service.ts';
import {
  DefaultHhMessagingBrowserDriver,
  HhMessagingService,
  type HhMessagingBrowserDriver,
  type UnreadNegotiationItem,
} from '../src/modules/hh-hybrid/hh-messaging.service.ts';
import {
  HhHybridService,
  type PlaywrightBrowserDriver,
  type ScrapedVacancyDetailsResult,
} from '../src/modules/hh-hybrid/hh-hybrid.service.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
    CREATE TABLE "user_profile" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "hhResumeTitle" TEXT NOT NULL, "resumeRawText" TEXT NOT NULL, "customPromptRules" TEXT);
    CREATE TABLE "search_filters" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "queryText" TEXT NOT NULL, "excludedWords" TEXT, "areaId" TEXT, "schedule" TEXT, "salaryFrom" INTEGER);
    CREATE TABLE "application_records" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "vacancyId" TEXT NOT NULL UNIQUE, "companyName" TEXT NOT NULL, "positionTitle" TEXT NOT NULL, "salaryText" TEXT NOT NULL, "vacancyUrl" TEXT NOT NULL, "coverLetter" TEXT NOT NULL, "status" TEXT NOT NULL, "matchScore" INTEGER, "aiReasoning" TEXT, "lastEmployerMessage" TEXT, "isNotified" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
    CREATE TABLE "negotiation_messages" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "negotiation_id" TEXT NOT NULL UNIQUE, "vacancy_id" TEXT NOT NULL, "company_name" TEXT NOT NULL, "position_title" TEXT NOT NULL, "chat_url" TEXT NOT NULL, "last_unread_text" TEXT NOT NULL, "chat_history_json" TEXT NOT NULL, "extracted_contacts" TEXT, "telegram_message_id" INTEGER, "reply_status" TEXT NOT NULL DEFAULT 'unread_notified', "ai_generated_reply" TEXT, "updated_at" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function createTempLogger(): { logger: AgentLoggerService; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logger-test-'));
  const logger = new AgentLoggerService({ logsDir: tempDir });
  return {
    logger,
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}

test('HhHybridService.runWithSession serializes calls with searchVacancies and resets HH_IS_LOGGED_IN to false on login redirect', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'true');

  const executionOrder: string[] = [];

  const mockDriver: PlaywrightBrowserDriver = {
    loginAndScrapeResume: async () => ({
      data: { hhResumeTitle: 'Dev', resumeRawText: 'Text' },
      error: null,
    }),
    searchVacanciesInBrowser: async () => {
      executionOrder.push('searchVacancies');
      return {
        data: { items: [], found: 0, page: 0, pages: 0, per_page: 20 },
        error: null,
      };
    },
    scrapeVacancyDetailsInBrowser: async () => ({ data: null, error: 'Not implemented' }),
    applyInBrowser: async () => ({ data: true, error: null }),
    scrapeNegotiationsInBrowser: async () => ({ data: [], error: null }),
    bumpResumeInBrowser: async () => ({ data: 'bumped', error: null }),
  };

  const hybridService = new HhHybridService(configStore, db, { customDriver: mockDriver });

  const sessionPromise = hybridService.runWithSession(async () => {
    executionOrder.push('session-start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    executionOrder.push('session-end');
    return { data: 'session-ok', error: null };
  });

  const searchPromise = hybridService.searchVacancies({ queryText: 'TypeScript' });

  const [sessionRes, searchRes] = await Promise.all([sessionPromise, searchPromise]);

  assert.equal(sessionRes.data, 'session-ok');
  assert.equal(searchRes.error, null);
  assert.deepEqual(executionOrder, ['session-start', 'session-end', 'searchVacancies']);

  const loginRedirectRes = await hybridService.runWithSession(async () => {
    return { data: null, error: 'Redirected to /account/login' };
  });

  assert.equal(loginRedirectRes.error, 'Redirected to /account/login');
  assert.equal(configStore.get('HH_IS_LOGGED_IN').data, 'false');

  const blockedRes = await hybridService.runWithSession(async () => {
    return { data: 'should-not-run', error: null };
  });

  assert.equal(blockedRes.data, null);
  assert.equal(blockedRes.error, 'Сессия HH.ru не авторизована.');
});

test('HhMessagingService.fetchUnreadNegotiations rejects when HH_IS_LOGGED_IN is not true', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'false');

  const hybridService = new HhHybridService(configStore, db);
  const messagingService = new HhMessagingService(hybridService);

  const result = await messagingService.fetchUnreadNegotiations();

  assert.equal(result.data, null);
  assert.equal(result.error, 'Сессия HH.ru не авторизована.');
});

test('HhMessagingService.fetchUnreadNegotiations returns unread items and logs INFO', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'true');

  const { logger, cleanup } = createTempLogger();

  try {
    const mockUnreadItems: UnreadNegotiationItem[] = [
      {
        negotiationId: 'neg-101',
        vacancyId: 'vac-201',
        companyName: 'TechCorp',
        positionTitle: 'Senior Node Developer',
        chatUrl: 'https://hh.ru/applicant/negotiations/item/neg-101',
        unreadMessages: ['Когда вы сможете приступить?'],
        fullHistory: [
          { sender: 'employer', text: 'Здравствуйте! Ваше резюме нас заинтересовало.' },
          { sender: 'applicant', text: 'Добрый день! Спасибо за отклик.' },
          { sender: 'employer', text: 'Когда вы сможете приступить?' },
        ],
      },
    ];

    const mockDriver: HhMessagingBrowserDriver = {
      fetchUnreadInBrowser: async () => ({
        data: mockUnreadItems,
        error: null,
      }),
      sendChatInBrowser: async () => ({
        data: true,
        error: null,
      }),
    };

    const hybridService = new HhHybridService(configStore, db);
    const messagingService = new HhMessagingService(hybridService, {
      customDriver: mockDriver,
      loggerService: logger,
    });

    const result = await messagingService.fetchUnreadNegotiations('trace-msg-001');

    assert.equal(result.error, null);
    assert.equal(result.data?.length, 1);
    assert.equal(result.data?.[0].negotiationId, 'neg-101');
    assert.equal(result.data?.[0].companyName, 'TechCorp');
    assert.equal(result.data?.[0].unreadMessages[0], 'Когда вы сможете приступить?');
  } finally {
    cleanup();
  }
});

test('HhMessagingService.sendChatMessage validates non-empty negotiationId and replyText', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'true');

  const hybridService = new HhHybridService(configStore, db);
  const messagingService = new HhMessagingService(hybridService);

  const emptyIdRes = await messagingService.sendChatMessage('', 'Hello');
  assert.equal(emptyIdRes.data, null);
  assert.match(emptyIdRes.error ?? '', /negotiationId and replyText cannot be empty/);

  const whitespaceIdRes = await messagingService.sendChatMessage('   ', 'Hello');
  assert.equal(whitespaceIdRes.data, null);
  assert.match(whitespaceIdRes.error ?? '', /negotiationId and replyText cannot be empty/);

  const emptyTextRes = await messagingService.sendChatMessage('neg-1', '');
  assert.equal(emptyTextRes.data, null);
  assert.match(emptyTextRes.error ?? '', /negotiationId and replyText cannot be empty/);

  const whitespaceTextRes = await messagingService.sendChatMessage('neg-1', '   \n\t  ');
  assert.equal(whitespaceTextRes.data, null);
  assert.match(whitespaceTextRes.error ?? '', /negotiationId and replyText cannot be empty/);
});

test('HhMessagingService.sendChatMessage delegates through runWithSession and logs SEND_CHAT_MESSAGE', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'true');

  const { logger, cleanup } = createTempLogger();

  try {
    let capturedSessionDir = '';
    let capturedNegId = '';
    let capturedReplyText = '';
    let capturedTraceId = '';

    const mockDriver: HhMessagingBrowserDriver = {
      fetchUnreadInBrowser: async () => ({ data: [], error: null }),
      sendChatInBrowser: async (sessionDir, negotiationId, replyText, traceId) => {
        capturedSessionDir = sessionDir;
        capturedNegId = negotiationId;
        capturedReplyText = replyText;
        capturedTraceId = traceId;
        return { data: true, error: null };
      },
    };

    const hybridService = new HhHybridService(configStore, db);
    const messagingService = new HhMessagingService(hybridService, {
      customDriver: mockDriver,
      loggerService: logger,
    });

    const result = await messagingService.sendChatMessage(
      'neg-404',
      'Здравствуйте! Готов выполнить тестовое задание.',
      'custom-trace-777'
    );

    assert.equal(result.data, true);
    assert.equal(result.error, null);
    assert.ok(capturedSessionDir.includes('hh-session'));
    assert.equal(capturedNegId, 'neg-404');
    assert.equal(capturedReplyText, 'Здравствуйте! Готов выполнить тестовое задание.');
    assert.equal(capturedTraceId, 'custom-trace-777');
  } finally {
    cleanup();
  }
});

test('DefaultHhMessagingBrowserDriver.sendChatInBrowser sends message and verifies input cleared', async () => {
  const { logger, cleanup } = createTempLogger();

  const originalLaunch = chromium.launchPersistentContext;
  try {
    let currentInputValue = '';
    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      locator: (selector: string) => {
        if (selector.includes('chatik-do-send-message')) {
          return {
            first: () => ({
              isVisible: async () => true,
              click: async () => {
                currentInputValue = '';
              },
              dispatchEvent: async () => {},
            }),
          };
        }
        return {
          first: () => ({
            waitFor: async () => true,
            focus: async () => {},
            fill: async (text: string) => {
              currentInputValue = text;
            },
            press: async () => {
              currentInputValue = '';
            },
            inputValue: async () => currentInputValue,
          }),
        };
      },
      url: () => 'https://hh.ru/chat/12345',
      waitForTimeout: async () => {},
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {},
    };

    chromium.launchPersistentContext = async () => fakeContext as never;

    const driver = new DefaultHhMessagingBrowserDriver('https://hh.ru', logger);
    const result = await driver.sendChatInBrowser('/tmp/fake-session', 'neg-12345', 'Hello, test message', 'trace-success-1');

    assert.equal(result.data, true);
    assert.equal(result.error, null);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    cleanup();
  }
});

test('DefaultHhMessagingBrowserDriver.sendChatInBrowser fails and logs when textarea not found', async () => {
  const { logger, cleanup } = createTempLogger();

  const originalLaunch = chromium.launchPersistentContext;
  try {
    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            throw new Error('Element not found');
          },
          fill: async () => {},
          click: async () => {},
        }),
      }),
      url: () => 'https://hh.ru/applicant/negotiations/item/12345',
      title: async () => 'Chat Item',
      waitForTimeout: async () => {},
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {},
    };

    chromium.launchPersistentContext = async () => fakeContext as never;

    const driver = new DefaultHhMessagingBrowserDriver('https://hh.ru', logger);
    const result = await driver.sendChatInBrowser('/tmp/fake-session', 'neg-999', 'Hello', 'trace-fail-1');

    assert.equal(result.data, null);
    assert.equal(result.error, 'Поле ввода сообщения в чате HH.ru не найдено');

    const recentErrors = logger.readRecentErrors();
    assert.ok(recentErrors.length >= 1);
    assert.equal(recentErrors[0].module, 'HH_MESSAGING');
    assert.equal(recentErrors[0].action, 'SEND_CHAT_MESSAGE');
    assert.equal(recentErrors[0].playwrightContext?.failedSelector, '[data-qa="chatik-new-message-text"]');
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    cleanup();
  }
});

test('DefaultHhMessagingBrowserDriver.fetchUnreadInBrowser logs error on redirect to /account/login', async () => {
  const { logger, cleanup } = createTempLogger();

  const originalLaunch = chromium.launchPersistentContext;
  try {
    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      url: () => 'https://hh.ru/account/login?backurl=%2Fapplicant%2Fnegotiations',
      title: async () => 'Вход в HH.ru',
      waitForTimeout: async () => {},
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {},
    };

    chromium.launchPersistentContext = async () => fakeContext as never;

    const driver = new DefaultHhMessagingBrowserDriver('https://hh.ru', logger);
    const result = await driver.fetchUnreadInBrowser('/tmp/fake-session', 'trace-login-redirect');

    assert.equal(result.data, null);
    assert.equal(result.error, 'Сессия HH.ru не авторизована (/account/login).');

    const recentErrors = logger.readRecentErrors();
    assert.ok(recentErrors.length >= 1);
    assert.equal(recentErrors[0].module, 'HH_MESSAGING');
    assert.equal(recentErrors[0].action, 'FETCH_UNREAD_NEGOTIATIONS');
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    cleanup();
  }
});

test('DefaultPlaywrightBrowserDriver logs VACANCY_NAVIGATION on HTTP 403', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('HH_IS_LOGGED_IN', 'true');

  const { logger, cleanup } = createTempLogger();

  const originalLaunch = chromium.launchPersistentContext;
  try {
    const fakePage = {
      goto: async () => ({ status: () => 403 }),
      url: () => 'https://hh.ru/search/vacancy?text=Node',
      title: async () => '403 Forbidden',
      locator: () => ({
        first: () => ({
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => [],
      waitForTimeout: async () => {},
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {},
    };

    chromium.launchPersistentContext = async () => fakeContext as never;

    const hybridService = new HhHybridService(configStore, db);
    const result = await hybridService.searchVacancies({ queryText: 'Node' });

    assert.equal(result.data, null);
    assert.ok(result.error?.includes('403'));
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    cleanup();
  }
});

test('syncUnreadMessagesCore suppresses notifications for discarded vacancies and refusal messages', async () => {
  const { db } = createTestDatabase();
  let notificationCount = 0;

  const mockMessaging = {
    fetchUnreadNegotiations: async () => ({
      data: [
        {
          negotiationId: 'neg-discard-1',
          vacancyId: 'vac-discard-1',
          companyName: 'Company A',
          positionTitle: 'Dev',
          chatUrl: 'https://hh.ru/chat/neg-discard-1',
          unreadMessages: ['Отказ'],
          fullHistory: [{ sender: 'employer' as const, text: 'К сожалению, мы не готовы пригласить вас' }],
        },
        {
          negotiationId: 'neg-ok-1',
          vacancyId: 'vac-ok-1',
          companyName: 'Company B',
          positionTitle: 'Lead',
          chatUrl: 'https://hh.ru/chat/neg-ok-1',
          unreadMessages: ['Когда вам удобно созвониться?'],
          fullHistory: [{ sender: 'employer' as const, text: 'Когда вам удобно созвониться?' }],
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
      notificationCount++;
      return { data: 12345, error: null };
    },
  });

  assert.equal(res.data?.notifiedCount, 1);
  assert.equal(notificationCount, 1);
});

test('DefaultHhMessagingBrowserDriver does not throw when context.close rejects during finally', async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const { logger, cleanup } = createTempLogger();
  try {
    const fakePage = {
      goto: async () => ({ status: () => 200 }),
      url: () => 'https://hh.ru/applicant/negotiations',
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            throw new Error('Navigation failed');
          },
        }),
      }),
      evaluate: async () => [],
      waitForTimeout: async () => {},
    };

    const fakeContext = {
      pages: () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {
        throw new Error('Target closed: browser process died');
      },
    };

    chromium.launchPersistentContext = async () => fakeContext as never;

    const driver = new DefaultHhMessagingBrowserDriver('https://hh.ru', logger);

    const fetchResult = await driver.fetchUnreadInBrowser('/tmp/test-session', 'trace-fetch-1');
    assert.deepEqual(fetchResult.data, []);
    assert.equal(fetchResult.error, null);

    const sendResult = await driver.sendChatInBrowser(
      '/tmp/test-session',
      'neg-123',
      'Hello',
      'trace-send-1'
    );
    assert.equal(sendResult.data, null);
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    cleanup();
  }
});
