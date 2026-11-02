import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentLoggerService,
  MAX_LOG_BYTES,
  RETAIN_LOG_BYTES,
} from '../src/modules/logger/index.ts';
import { CircuitBreaker } from '../src/utils/circuit-breaker.util.ts';
import {
  calculateJitterDelayMs,
  calculateNextRunWithJitter,
  MIN_JITTER_DELAY_MS,
} from '../src/utils/jitter.util.ts';

test('AgentLoggerService rotates 21 MB debug log down to 10 MB and maintains valid JSON lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-log-cap-'));
  const debugPath = path.join(tmpDir, 'agent-debug.jsonl');
  const tmpSwapPath = `${debugPath}.tmp`;

  try {
    const logger = new AgentLoggerService({ logsDir: tmpDir, enabled: true, maxLogLines: 200000 });

    const sampleLine =
      JSON.stringify({
        timestamp: '2026-10-22T00:00:00.000Z',
        level: 'INFO',
        traceId: '00000000-0000-0000-0000-000000000000',
        module: 'HH_BROWSER',
        action: 'SEED_RECORD',
        message: 'Предустановленная запись журнала с кириллицей для проверки UTF-8',
      }) + '\n';

    const chunk = Buffer.from(sampleLine.repeat(500), 'utf8');
    const targetBytes = 21 * 1024 * 1024 + 1024;
    let written = 0;
    const fd = fs.openSync(debugPath, 'w');
    try {
      while (written < targetBytes) {
        fs.writeSync(fd, chunk);
        written += chunk.length;
      }
    } finally {
      fs.closeSync(fd);
    }

    assert.ok(fs.statSync(debugPath).size > MAX_LOG_BYTES);

    logger.logInfo({
      module: 'SYSTEM',
      action: 'ROTATION_TEST',
      message: 'Проверка ротации 20 МБ',
    });

    const finalSize = fs.statSync(debugPath).size;
    assert.ok(finalSize <= MAX_LOG_BYTES);
    assert.ok(finalSize >= 9 * 1024 * 1024);
    assert.equal(fs.existsSync(tmpSwapPath), false);

    const content = fs.readFileSync(debugPath, 'utf8');
    const lines = content.trim().split('\n');
    assert.ok(lines.length >= 40);

    const first20 = lines.slice(0, 20);
    for (const line of first20) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed, 'object');
      assert.notEqual(parsed, null);
    }

    const last20 = lines.slice(-20);
    for (const line of last20) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed, 'object');
      assert.notEqual(parsed, null);
    }

    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastLine.action, 'ROTATION_TEST');
    assert.equal(lastLine.module, 'SYSTEM');
    assert.equal(lastLine.message, 'Проверка ротации 20 МБ');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AgentLoggerService rotates agent-errors.jsonl with custom byte limits', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-log-err-'));
  const errorPath = path.join(tmpDir, 'agent-errors.jsonl');
  const tmpSwapPath = `${errorPath}.tmp`;

  try {
    const logger = new AgentLoggerService({
      logsDir: tmpDir,
      enabled: true,
      maxLogBytes: 4096,
      retainLogBytes: 2048,
    });

    const sampleLine =
      JSON.stringify({
        timestamp: '2026-10-22T00:00:00.000Z',
        level: 'ERROR',
        traceId: '11111111-1111-1111-1111-111111111111',
        module: 'DB',
        action: 'SEED_ERROR',
        message: 'Ошибка подключения к базе данных с русским текстом',
        error: {
          name: 'DatabaseError',
          message: 'Connection pool exhausted',
          DiagnosticHintForAgent: 'Restart connection pool',
        },
      }) + '\n';

    const chunk = Buffer.from(sampleLine.repeat(20), 'utf8');
    fs.writeFileSync(errorPath, chunk);
    assert.ok(fs.statSync(errorPath).size > 4096);

    logger.logError({
      module: 'DB',
      action: 'ROTATION_TEST_ERROR',
      message: 'Ошибка БД: UTF-8 тест',
      hint: 'Проверить соединение',
    });

    const finalSize = fs.statSync(errorPath).size;
    assert.ok(finalSize <= 4096);
    assert.ok(finalSize >= 1500);
    assert.equal(fs.existsSync(tmpSwapPath), false);

    const content = fs.readFileSync(errorPath, 'utf8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed, 'object');
      assert.notEqual(parsed, null);
    }

    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastLine.action, 'ROTATION_TEST_ERROR');
    assert.equal(lastLine.module, 'DB');
    assert.equal(lastLine.message, 'Ошибка БД: UTF-8 тест');
    assert.equal(lastLine.error?.DiagnosticHintForAgent, 'Проверить соединение');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AgentLoggerService rotates pre-existing oversized file on constructor and configure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-log-init-'));
  const debugPath = path.join(tmpDir, 'agent-debug.jsonl');

  try {
    const line =
      JSON.stringify({
        timestamp: '2026-10-22T00:00:00.000Z',
        level: 'INFO',
        traceId: 'test-trace',
        module: 'DB',
        action: 'INIT',
        message: 'Служебная строка журнала для тестирования инициализации',
      }) + '\n';

    fs.writeFileSync(debugPath, Buffer.from(line.repeat(30), 'utf8'));
    const preSize = fs.statSync(debugPath).size;
    assert.ok(preSize > 3000);

    const logger = new AgentLoggerService({
      logsDir: tmpDir,
      enabled: true,
      maxLogBytes: 2000,
      retainLogBytes: 1000,
    });

    const postSize = fs.statSync(debugPath).size;
    assert.ok(postSize <= 2000);
    assert.ok(postSize >= 500);

    fs.writeFileSync(debugPath, Buffer.from(line.repeat(30), 'utf8'));
    assert.ok(fs.statSync(debugPath).size > 3000);

    logger.configure({
      maxLogBytes: 1500,
      retainLogBytes: 800,
    });

    const configuredSize = fs.statSync(debugPath).size;
    assert.ok(configuredSize <= 1500);
    assert.ok(configuredSize >= 400);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('calculateJitterDelayMs maintains bounded values, minimum floor, and entropy', () => {
  for (let i = 0; i < 200; i++) {
    const delay = calculateJitterDelayMs(3, 2);
    assert.ok(delay >= 60_000);
    assert.ok(delay <= 300_999);
  }

  const entropySamples: number[] = [];
  for (let i = 0; i < 50; i++) {
    entropySamples.push(calculateJitterDelayMs(3, 2));
  }
  const subSeconds = new Set(entropySamples.map((ms) => ms % 1000));
  assert.ok(subSeconds.size > 10);

  for (let i = 0; i < 100; i++) {
    const clampedDelay = calculateJitterDelayMs(0.5, 2);
    assert.ok(clampedDelay >= MIN_JITTER_DELAY_MS);
  }

  const zeroRangeDelay = calculateJitterDelayMs(2, 0);
  assert.ok(zeroRangeDelay >= 120_000);
  assert.ok(zeroRangeDelay <= 120_999);
});

test('calculateNextRunWithJitter computes correct future dates', () => {
  const fixedNow = 1_700_000_000_000;
  for (let i = 0; i < 50; i++) {
    const nextRun = calculateNextRunWithJitter(3, 2, fixedNow);
    assert.ok(nextRun instanceof Date);
    const time = nextRun.getTime();
    assert.ok(time >= 1_700_000_060_000);
    assert.ok(time <= 1_700_000_300_999);
  }

  const defaultNextRun = calculateNextRunWithJitter();
  assert.ok(defaultNextRun instanceof Date);
  assert.ok(defaultNextRun.getTime() >= Date.now() + 59_000);
});

test('rotateFileIfNeeded safely ignores non-existent files', () => {
  const logger = new AgentLoggerService({ enabled: true });
  assert.doesNotThrow(() => {
    logger.rotateFileIfNeeded('/non/existent/path/for/safety/check.jsonl', 100);
  });
});

test('CircuitBreaker opens after threshold failures and recovers after cooldownMs', () => {
  let now = 1000;
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000, nowFn: () => now });
  assert.equal(cb.canExecute(), true);
  assert.equal(cb.recordFailure(), false);
  assert.equal(cb.recordFailure(), false);
  assert.equal(cb.recordFailure(), true);
  assert.equal(cb.getState(), 'OPEN');
  assert.equal(cb.canExecute(), false);
  now += 61_000;
  assert.equal(cb.getState(), 'HALF_OPEN');
  assert.equal(cb.canExecute(), true);
  cb.recordSuccess();
  assert.equal(cb.getState(), 'CLOSED');
  assert.equal(cb.canExecute(), true);
});

test('CircuitBreaker re-opens immediately on failure when HALF_OPEN', () => {
  let now = 1000;
  const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000, nowFn: () => now });
  assert.equal(cb.recordFailure(), false);
  assert.equal(cb.recordFailure(), true);
  assert.equal(cb.getState(), 'OPEN');
  now += 35_000;
  assert.equal(cb.getState(), 'HALF_OPEN');
  assert.equal(cb.recordFailure(), true);
  assert.equal(cb.getState(), 'OPEN');
  assert.equal(cb.canExecute(), false);
  cb.reset();
  assert.equal(cb.getState(), 'CLOSED');
  assert.equal(cb.canExecute(), true);
});

test('AgentLoggerService pruneSnapshots removes oldest png files exceeding maxFiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-snap-prune-'));
  try {
    const logger = new AgentLoggerService({ logsDir: tmpDir, enabled: true, maxLogLines: 200000 });
    const snapshotsDir = path.join(tmpDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    for (let i = 0; i < 15; i++) {
      const filePath = path.join(snapshotsDir, `snap-${String(i).padStart(2, '0')}.png`);
      fs.writeFileSync(filePath, 'dummy');
      const timeSec = 1_000_000 + i * 10;
      fs.utimesSync(filePath, timeSec, timeSec);
    }
    fs.writeFileSync(path.join(snapshotsDir, 'ignore.txt'), 'not-png');

    const deletedCount = logger.pruneSnapshots(10);
    assert.equal(deletedCount, 5);

    const remaining = fs.readdirSync(snapshotsDir);
    assert.ok(remaining.includes('ignore.txt'));
    assert.equal(remaining.filter((f) => f.endsWith('.png')).length, 10);
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'snap-00.png')), false);
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'snap-04.png')), false);
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'snap-05.png')), true);
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'snap-14.png')), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

