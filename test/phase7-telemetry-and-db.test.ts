import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { Page } from 'playwright';
import { createDatabaseContext } from '../src/db/index.ts';
import { negotiationMessages } from '../src/db/schema.ts';
import {
  AgentLoggerService,
  agentLogger,
} from '../src/modules/logger/index.ts';
import {
  createLogger,
  mapScopeToAgentModule,
  redactSensitiveText,
} from '../src/utils/logger.ts';

test('createDatabaseContext creates negotiation_messages table and supports CRUD', async () => {
  const dbFileName = 'test_phase7_negotiation.sqlite';
  const dbContext = createDatabaseContext(dbFileName);

  try {
    const inserted = await dbContext.db
      .insert(negotiationMessages)
      .values({
        negotiationId: 'neg-1001',
        vacancyId: 'vac-2002',
        companyName: 'Acme Corporation',
        positionTitle: 'Staff Backend Engineer',
        chatUrl: 'https://hh.ru/applicant/negotiations/item/neg-1001',
        lastUnreadText: 'Can you participate in a screening call tomorrow?',
        chatHistoryJson: JSON.stringify([
          {
            sender: 'employer',
            text: 'Can you participate in a screening call tomorrow?',
          },
        ]),
        telegramMessageId: 554433,
        replyStatus: 'unread_notified',
        updatedAt: '2026-10-21T18:00:00.000Z',
      })
      .returning();

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].negotiationId, 'neg-1001');

    const queried = await dbContext.db
      .select()
      .from(negotiationMessages)
      .where(eq(negotiationMessages.negotiationId, 'neg-1001'))
      .limit(1);

    assert.equal(queried.length, 1);
    assert.equal(queried[0].negotiationId, 'neg-1001');
    assert.equal(queried[0].vacancyId, 'vac-2002');
    assert.equal(queried[0].companyName, 'Acme Corporation');
    assert.equal(queried[0].positionTitle, 'Staff Backend Engineer');
    assert.equal(queried[0].replyStatus, 'unread_notified');
    assert.equal(queried[0].aiGeneratedReply, null);
    assert.equal(queried[0].telegramMessageId, 554433);

    await dbContext.db
      .update(negotiationMessages)
      .set({
        replyStatus: 'replied_by_ai',
        aiGeneratedReply: 'Yes, I am available tomorrow at 14:00 UTC.',
        updatedAt: '2026-10-21T18:05:00.000Z',
      })
      .where(eq(negotiationMessages.negotiationId, 'neg-1001'));

    const updated = await dbContext.db
      .select()
      .from(negotiationMessages)
      .where(eq(negotiationMessages.negotiationId, 'neg-1001'))
      .limit(1);

    assert.equal(updated.length, 1);
    assert.equal(updated[0].replyStatus, 'replied_by_ai');
    assert.equal(
      updated[0].aiGeneratedReply,
      'Yes, I am available tomorrow at 14:00 UTC.'
    );
  } finally {
    dbContext.close();
    const dbPath = path.resolve(process.cwd(), dbFileName);
    for (const suffix of ['', '-wal', '-shm']) {
      const targetPath = `${dbPath}${suffix}`;
      if (fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
        } catch {
        }
      }
    }
  }
});

test('AgentLoggerService writes valid JSONL lines, redacts tokens, and reads newest-first errors', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logger-test-'));
  const logger = new AgentLoggerService({ logsDir: tmpDir });

  try {
    const initialErrors = logger.readRecentErrors(5);
    assert.deepEqual(initialErrors, []);

    const sensitiveToken = '123456789:ABCDEF123456789012345678_token';
    const infoEntry = logger.logInfo({
      module: 'SCHEDULER',
      action: 'BOOTSTRAP',
      message: `System started with bot${sensitiveToken}`,
      durationMs: 15,
      metadata: { runId: 'run-1' },
    });

    assert.equal(infoEntry.level, 'INFO');
    assert.equal(
      infoEntry.message,
      'System started with bot[REDACTED_BOT_TOKEN]'
    );
    assert.equal(infoEntry.module, 'SCHEDULER');

    const warnEntry = logger.logWarn({
      module: 'TELEGRAM_BOT',
      action: 'THROTTLE',
      message: `Warning regarding token ${sensitiveToken}`,
    });

    assert.equal(warnEntry.level, 'WARN');
    assert.equal(
      warnEntry.message,
      'Warning regarding token bot[REDACTED_BOT_TOKEN]'
    );

    const debugPath = path.join(tmpDir, 'agent-debug.jsonl');
    const errorsPath = path.join(tmpDir, 'agent-errors.jsonl');

    assert.equal(fs.existsSync(debugPath), true);
    assert.equal(fs.existsSync(errorsPath), false);

    const debugLinesBeforeErrors = fs
      .readFileSync(debugPath, 'utf8')
      .trim()
      .split('\n');
    assert.equal(debugLinesBeforeErrors.length, 2);

    for (let index = 1; index <= 7; index++) {
      logger.logError({
        module: 'HH_MESSAGING',
        action: `FETCH_FAIL_${index}`,
        message: `Failure at step ${index} with bot${sensitiveToken}`,
        error: new Error(`Http error ${index}`),
        hint: `Diagnostic hint for step ${index}`,
      });
    }

    assert.equal(fs.existsSync(errorsPath), true);

    const recentFive = logger.readRecentErrors(5);
    assert.equal(recentFive.length, 5);
    assert.equal(recentFive[0].action, 'FETCH_FAIL_7');
    assert.equal(recentFive[1].action, 'FETCH_FAIL_6');
    assert.equal(recentFive[2].action, 'FETCH_FAIL_5');
    assert.equal(recentFive[3].action, 'FETCH_FAIL_4');
    assert.equal(recentFive[4].action, 'FETCH_FAIL_3');

    assert.equal(
      recentFive[0].message,
      'Failure at step 7 with bot[REDACTED_BOT_TOKEN]'
    );
    assert.equal(
      recentFive[0].error?.DiagnosticHintForAgent,
      'Diagnostic hint for step 7'
    );
    assert.equal(recentFive[0].error?.name, 'Error');

    const debugLines = fs.readFileSync(debugPath, 'utf8').trim().split('\n');
    assert.equal(debugLines.length, 9);
    for (const line of debugLines) {
      assert.doesNotThrow(() => JSON.parse(line));
      assert.equal(line.includes(sensitiveToken), false);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AgentLoggerService.logPlaywrightError captures context and gracefully handles errors', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logger-pw-'));
  const logger = new AgentLoggerService({ logsDir: tmpDir });

  try {
    const longText = 'Applicant Chat DOM Content '.repeat(150);
    let screenshotSaved = false;

    const mockPage = {
      url: () => 'https://hh.ru/applicant/negotiations/item/chat-888',
      title: async () => 'Negotiation Thread #888',
      locator: (_selector: string) => ({
        innerText: async () => longText,
      }),
      screenshot: async (opts: { path: string }) => {
        fs.writeFileSync(opts.path, Buffer.from('mock-png-bytes'));
        screenshotSaved = true;
      },
    } as unknown as Page;

    const entry = await logger.logPlaywrightError({
      traceId: 'trace-pw-ok',
      module: 'HH_MESSAGING',
      action: 'SEND_PROPOSAL',
      error: new Error('Button disabled: bot123456789:ABCDEF123456789012345678_token'),
      page: mockPage,
      failedSelector: 'button[data-qa="reply-submit"]',
      httpStatus: 429,
      hint: 'Rate limit or disabled submit button',
    });

    assert.equal(screenshotSaved, true);
    assert.equal(entry.level, 'ERROR');
    assert.equal(entry.module, 'HH_MESSAGING');
    assert.equal(entry.action, 'SEND_PROPOSAL');
    assert.ok(entry.playwrightContext);
    assert.equal(
      entry.playwrightContext.currentUrl,
      'https://hh.ru/applicant/negotiations/item/chat-888'
    );
    assert.equal(
      entry.playwrightContext.pageTitle,
      'Negotiation Thread #888'
    );
    assert.equal(
      entry.playwrightContext.failedSelector,
      'button[data-qa="reply-submit"]'
    );
    assert.equal(entry.playwrightContext.httpStatus, 429);
    assert.equal(
      entry.playwrightContext.screenshotPath,
      'logs/snapshots/trace-pw-ok.png'
    );
    assert.ok(entry.playwrightContext.domSnippet);
    assert.ok(entry.playwrightContext.domSnippet.length <= 2000);
    assert.equal(entry.error?.DiagnosticHintForAgent, 'Rate limit or disabled submit button');
    assert.equal(
      entry.message,
      'Button disabled: bot[REDACTED_BOT_TOKEN]'
    );

    const snapshotDiskPath = path.join(tmpDir, 'snapshots', 'trace-pw-ok.png');
    assert.equal(fs.existsSync(snapshotDiskPath), true);

    const failingPage = {
      url: () => {
        throw new Error('Context was destroyed');
      },
      title: async () => {
        throw new Error('Title execution context lost');
      },
      locator: () => ({
        innerText: async () => {
          throw new Error('Locator crashed');
        },
      }),
      innerHTML: async () => {
        throw new Error('InnerHTML crashed');
      },
      screenshot: async () => {
        throw new Error('Screenshot crashed');
      },
    } as unknown as Page;

    const resilientEntry = await logger.logPlaywrightError({
      traceId: 'trace-pw-fail',
      module: 'HH_BROWSER',
      action: 'PAGE_CRASH',
      error: new Error('Execution context was destroyed'),
      page: failingPage,
      hint: 'Chromium page crashed during navigation',
    });

    assert.equal(resilientEntry.level, 'ERROR');
    assert.ok(resilientEntry.playwrightContext);
    assert.equal(resilientEntry.playwrightContext.currentUrl, 'unknown');
    assert.equal(resilientEntry.playwrightContext.pageTitle, undefined);
    assert.equal(resilientEntry.playwrightContext.domSnippet, undefined);
    assert.equal(resilientEntry.playwrightContext.screenshotPath, undefined);

    const noPageEntry = await logger.logPlaywrightError({
      traceId: 'trace-no-page',
      module: 'DB',
      action: 'DIRECT_ERROR',
      error: 'Text error string',
      failedSelector: 'table#missing',
      httpStatus: 500,
      hint: 'DB table is locked',
    });

    assert.equal(noPageEntry.level, 'ERROR');
    assert.ok(noPageEntry.playwrightContext);
    assert.equal(noPageEntry.playwrightContext.currentUrl, 'unknown');
    assert.equal(noPageEntry.playwrightContext.failedSelector, 'table#missing');
    assert.equal(noPageEntry.playwrightContext.httpStatus, 500);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createLogger mirrors events to agentLogger with correct module mapping', () => {
  assert.equal(mapScopeToAgentModule('HhHybrid'), 'HH_BROWSER');
  assert.equal(mapScopeToAgentModule('HH_BROWSER'), 'HH_BROWSER');
  assert.equal(mapScopeToAgentModule('HhMessaging'), 'HH_MESSAGING');
  assert.equal(mapScopeToAgentModule('HH_MESSAGING'), 'HH_MESSAGING');
  assert.equal(mapScopeToAgentModule('Llm'), 'LLM_SERVICE');
  assert.equal(mapScopeToAgentModule('LLM'), 'LLM_SERVICE');
  assert.equal(mapScopeToAgentModule('Telegram'), 'TELEGRAM_BOT');
  assert.equal(mapScopeToAgentModule('TELEGRAM_BOT'), 'TELEGRAM_BOT');
  assert.equal(mapScopeToAgentModule('Scheduler'), 'SCHEDULER');
  assert.equal(mapScopeToAgentModule('Exporter'), 'DB');
  assert.equal(mapScopeToAgentModule('Database'), 'DB');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logger-mirror-'));
  agentLogger.configure({ logsDir: tmpDir, enabled: true });

  try {
    const hhLogger = createLogger('HhHybrid');
    hhLogger.info('Browser initialized');
    hhLogger.warn('Slow network');
    hhLogger.error('Navigation timeout', new Error('Timeout 30000ms'));

    const debugPath = path.join(tmpDir, 'agent-debug.jsonl');
    const errorsPath = path.join(tmpDir, 'agent-errors.jsonl');

    assert.equal(fs.existsSync(debugPath), true);
    assert.equal(fs.existsSync(errorsPath), true);

    const debugEntries = fs
      .readFileSync(debugPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    assert.equal(debugEntries.length, 3);
    assert.equal(debugEntries[0].module, 'HH_BROWSER');
    assert.equal(debugEntries[0].level, 'INFO');
    assert.equal(debugEntries[0].action, 'HhHybrid');
    assert.equal(debugEntries[0].message, 'Browser initialized');

    assert.equal(debugEntries[1].module, 'HH_BROWSER');
    assert.equal(debugEntries[1].level, 'WARN');

    assert.equal(debugEntries[2].module, 'HH_BROWSER');
    assert.equal(debugEntries[2].level, 'ERROR');

    const recentErrors = agentLogger.readRecentErrors(5);
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0].module, 'HH_BROWSER');
    assert.equal(recentErrors[0].message, 'Navigation timeout');
  } finally {
    agentLogger.configure({
      logsDir: path.resolve(process.cwd(), 'logs'),
      enabled: process.env.AGENT_LOGS_DISABLED !== 'true',
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
