import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { ConfigStoreService } from '../src/modules/config-store/config-store.service.ts';
import { AgentLoggerService } from '../src/modules/logger/agent-logger.service.ts';
import {
  LlmChatReplySchema,
  LlmReplyService,
  stripMarkdownFences,
  type GenerateEmployerReplyInput,
} from '../src/modules/llm/index.ts';

function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE "app_settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
  `);
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function createTempLogger(): { logger: AgentLoggerService; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-logger-reply-test-'));
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

interface CapturedRequest {
  url: string;
  options: RequestInit;
  bodyJson?: Record<string, unknown>;
}

function createMockFetch(handler: (req: CapturedRequest) => Promise<Response>) {
  const requests: CapturedRequest[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const options = init ?? {};
    let bodyJson: Record<string, unknown> | undefined;
    if (typeof options.body === 'string') {
      try {
        bodyJson = JSON.parse(options.body) as Record<string, unknown>;
      } catch {
      }
    }
    const captured: CapturedRequest = { url, options, bodyJson };
    requests.push(captured);
    return handler(captured);
  };
  return { fetchFn: fetchFn as typeof fetch, requests };
}

const sampleInput: GenerateEmployerReplyInput = {
  resumeRawText: 'Senior TypeScript Developer with 6 years experience in Node.js, Drizzle, and PostgreSQL.',
  companyName: 'Acme Corp',
  positionTitle: 'Lead Backend Engineer',
  chatHistory: [
    { sender: 'employer', text: 'Здравствуйте! Интересна ли вам позиция?', timestamp: '14:30' },
    { sender: 'applicant', text: 'Добрый день! Да, интересна стек и задачи.', timestamp: '14:32' },
  ],
  lastUnreadText: 'Отлично! Когда сможем провести технический созвон на 30 минут?',
  customPromptRules: 'Отвечать вежливо, соглашаться на предложенное время или уточнять график.',
  temperature: 0.65,
};

test('LlmReplyService parses valid Ollama response and forwards custom temperature 0.65', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn, requests } = createMockFetch(async () => {
      const payload = {
        replyText: 'Здравствуйте! Я готов провести созвон завтра во второй половине дня.',
        confidenceScore: 95,
        summaryOfIntent: 'Accept interview invitation and propose afternoon time',
      };
      return new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.error, null);
    assert.ok(result.data);
    assert.equal(result.data.replyText, 'Здравствуйте! Я готов провести созвон завтра во второй половине дня.');
    assert.equal(result.data.confidenceScore, 95);
    assert.equal(result.data.summaryOfIntent, 'Accept interview invitation and propose afternoon time');

    assert.equal(requests.length, 1);
    const captured = requests[0]!;
    assert.equal(captured.url, 'http://127.0.0.1:11434/api/generate');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.bodyJson?.model, 'gemma4:64k');
    assert.equal(captured.bodyJson?.format, 'json');
    assert.equal(captured.bodyJson?.stream, false);

    const bodyOptions = captured.bodyJson?.options as { temperature?: number };
    assert.equal(bodyOptions?.temperature, 0.65);

    const promptText = String(captured.bodyJson?.prompt ?? '');
    assert.ok(promptText.includes('Acme Corp'));
    assert.ok(promptText.includes('Lead Backend Engineer'));
    assert.ok(promptText.includes('Senior TypeScript Developer'));
    assert.ok(promptText.includes('Отлично! Когда сможем провести технический созвон на 30 минут?'));
    assert.ok(promptText.includes('Отвечать вежливо, соглашаться на предложенное время'));

    const recentErrors = logger.readRecentErrors(10);
    assert.equal(recentErrors.length, 0);
  } finally {
    cleanup();
  }
});

test('LlmReplyService defaults temperature to 0.35 when input temperature is omitted', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn, requests } = createMockFetch(async () => {
      const payload = {
        replyText: 'Здравствуйте! Готов обсудить детали вакансии.',
        confidenceScore: 80,
        summaryOfIntent: 'Express interest',
      };
      return new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const { temperature: _omitted, ...inputWithoutTemp } = sampleInput;
    const result = await service.generateEmployerReply(inputWithoutTemp);

    assert.equal(result.error, null);
    assert.ok(result.data);
    assert.equal(requests.length, 1);
    const bodyOptions = requests[0]!.bodyJson?.options as { temperature?: number };
    assert.equal(bodyOptions?.temperature, 0.35);
  } finally {
    cleanup();
  }
});

test('LlmReplyService strips markdown code fences around JSON output', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const wrappedContent = '```json\n{\n  "replyText": "Здравствуйте! Готов выполнить тестовое задание в указанный срок.",\n  "confidenceScore": 90,\n  "summaryOfIntent": "Accept test task"\n}\n```';

    const { fetchFn } = createMockFetch(async () => {
      return new Response(JSON.stringify({ response: wrappedContent }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.error, null);
    assert.ok(result.data);
    assert.equal(result.data.replyText, 'Здравствуйте! Готов выполнить тестовое задание в указанный срок.');
    assert.equal(result.data.confidenceScore, 90);
    assert.equal(result.data.summaryOfIntent, 'Accept test task');
  } finally {
    cleanup();
  }
});

test('stripMarkdownFences helper extracts inner JSON correctly', () => {
  const cases = [
    { input: '```json\n{"a": 1}\n```', expected: '{"a": 1}' },
    { input: '```\n{"a": 2}\n```', expected: '{"a": 2}' },
    { input: '```json{"a": 3}```', expected: '{"a": 3}' },
    { input: '{"a": 4}', expected: '{"a": 4}' },
    { input: '   {"a": 5}   ', expected: '{"a": 5}' },
    {
      input: 'Prefix text\n```json\n{"replyText": "test"}\n```\nPostfix note',
      expected: '{"replyText": "test"}',
    },
  ];

  for (const c of cases) {
    assert.equal(stripMarkdownFences(c.input), c.expected);
  }
});

test('LlmReplyService handles invalid JSON response, logs error with hint and returns exact message', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn } = createMockFetch(async () => {
      return new Response(JSON.stringify({ response: 'This is not valid JSON string at all!' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.data, null);
    assert.equal(result.error, 'LLM JSON output did not match LlmChatReplySchema');

    const recentErrors = logger.readRecentErrors(10);
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0]!.module, 'LLM_SERVICE');
    assert.equal(recentErrors[0]!.action, 'GENERATE_EMPLOYER_REPLY');
    assert.equal(recentErrors[0]!.message, 'LLM JSON validation failed');
    assert.equal(
      recentErrors[0]!.error?.DiagnosticHintForAgent,
      'LLM JSON output did not match LlmChatReplySchema'
    );
  } finally {
    cleanup();
  }
});

test('LlmReplyService handles schema mismatch (replyText < 10 chars), logs error with hint and returns exact message', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const invalidReply = {
      replyText: 'Too short',
      confidenceScore: 90,
      summaryOfIntent: 'Short intent',
    };

    const { fetchFn } = createMockFetch(async () => {
      return new Response(JSON.stringify({ response: JSON.stringify(invalidReply) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.data, null);
    assert.equal(result.error, 'LLM JSON output did not match LlmChatReplySchema');

    const recentErrors = logger.readRecentErrors(10);
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0]!.module, 'LLM_SERVICE');
    assert.equal(recentErrors[0]!.action, 'GENERATE_EMPLOYER_REPLY');
    assert.equal(recentErrors[0]!.message, 'LLM JSON validation failed');
    assert.equal(
      recentErrors[0]!.error?.DiagnosticHintForAgent,
      'LLM JSON output did not match LlmChatReplySchema'
    );
  } finally {
    cleanup();
  }
});

test('LlmReplyService handles HTTP failure (e.g. 500), logs error with hint and returns message', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn } = createMockFetch(async () => {
      return new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.data, null);
    assert.ok(result.error?.includes('HTTP 500'));

    const recentErrors = logger.readRecentErrors(10);
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0]!.module, 'LLM_SERVICE');
    assert.equal(recentErrors[0]!.action, 'GENERATE_EMPLOYER_REPLY');
    assert.equal(recentErrors[0]!.message, 'Failed to call Ollama /api/generate');
    assert.equal(
      recentErrors[0]!.error?.DiagnosticHintForAgent,
      'Verify Ollama server is running at LLM_BASE_URL and model is pulled'
    );
  } finally {
    cleanup();
  }
});

test('LlmReplyService handles network error (e.g. connection refused), logs error and returns message', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn } = createMockFetch(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.data, null);
    assert.equal(result.error, 'connect ECONNREFUSED 127.0.0.1:11434');

    const recentErrors = logger.readRecentErrors(10);
    assert.equal(recentErrors.length, 1);
    assert.equal(recentErrors[0]!.module, 'LLM_SERVICE');
    assert.equal(recentErrors[0]!.action, 'GENERATE_EMPLOYER_REPLY');
    assert.equal(recentErrors[0]!.message, 'Failed to call Ollama /api/generate');
    assert.equal(
      recentErrors[0]!.error?.DiagnosticHintForAgent,
      'Verify Ollama server is running at LLM_BASE_URL and model is pulled'
    );
  } finally {
    cleanup();
  }
});

test('LlmReplyService respects custom LLM_BASE_URL and LLM_MODEL_NAME from ConfigStore', async () => {
  const { db } = createTestDatabase();
  const configStore = new ConfigStoreService(db);
  configStore.set('LLM_BASE_URL', 'http://remote-ollama.internal:11434/');
  configStore.set('LLM_MODEL_NAME', 'qwen2.5:32b');
  const { logger, cleanup } = createTempLogger();

  try {
    const { fetchFn, requests } = createMockFetch(async () => {
      const payload = {
        replyText: 'Здравствуйте! Буду рад ответить на любые технические вопросы.',
        confidenceScore: 87,
        summaryOfIntent: 'Accept discussion',
      };
      return new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const service = new LlmReplyService(configStore, {
      customFetch: fetchFn,
      loggerService: logger,
    });

    const result = await service.generateEmployerReply(sampleInput);

    assert.equal(result.error, null);
    assert.ok(result.data);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'http://remote-ollama.internal:11434/api/generate');
    assert.equal(requests[0]!.bodyJson?.model, 'qwen2.5:32b');
  } finally {
    cleanup();
  }
});
