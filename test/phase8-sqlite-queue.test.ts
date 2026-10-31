import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabaseContext } from '../src/db/index.ts';
import { taskQueue } from '../src/db/schema.ts';
import {
  QueueWorkerService,
  SqliteQueueService,
  TASK_PRIORITY,
  type QueueTaskOutcome,
  type SafeResult,
} from '../src/modules/queue/index.ts';

function cleanDbFiles(dbFileName: string): void {
  const dbPath = path.resolve(process.cwd(), dbFileName);
  for (const suffix of ['', '-wal', '-shm']) {
    const targetPath = `${dbPath}${suffix}`;
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
      } catch {}
    }
  }
}

test('Spec Criterion 3: 5 simultaneous tasks priority and concurrency test', async () => {
  const dbFileName = 'test_phase8_criterion3.sqlite';
  cleanDbFiles(dbFileName);

  const ctx = createDatabaseContext(dbFileName);
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue, {
      tgRateLimitMs: 0,
      pollIntervalMs: 100,
    });

    const executionLog: Array<{ id: number; taskType: string }> = [];

    worker.registerHandler('SEND_TG_MESSAGE', async (task) => {
      executionLog.push({ id: task.id, taskType: task.taskType });
      return { data: 'completed' as QueueTaskOutcome, error: null };
    });

    worker.registerHandler('APPLY_VACANCY', async (task) => {
      executionLog.push({ id: task.id, taskType: task.taskType });
      return { data: 'completed' as QueueTaskOutcome, error: null };
    });

    const enqueuePromises = [
      queue.enqueue({
        taskType: 'APPLY_VACANCY',
        payload: { vacancyId: 'apply-1' },
      }),
      queue.enqueue({
        taskType: 'APPLY_VACANCY',
        payload: { vacancyId: 'apply-2' },
      }),
      queue.enqueue({
        taskType: 'SEND_TG_MESSAGE',
        payload: { text: 'message-1' },
      }),
      queue.enqueue({
        taskType: 'SEND_TG_MESSAGE',
        payload: { text: 'message-2' },
      }),
      queue.enqueue({
        taskType: 'SEND_TG_MESSAGE',
        payload: { text: 'message-3' },
      }),
    ];

    const enqueueResults = await Promise.all(enqueuePromises);

    for (const res of enqueueResults) {
      assert.equal(res.error, null);
      assert.ok(res.data);
      assert.ok(res.data.id > 0);
    }

    const allPersisted = ctx.db.select().from(taskQueue).limit(10).all();
    assert.equal(allPersisted.length, 5);

    const drainRes = await worker.drainAllDue(10);
    assert.equal(drainRes.error, null);
    assert.equal(drainRes.data, 5);

    assert.equal(executionLog.length, 5);

    const firstThreeTypes = executionLog.slice(0, 3).map((item) => item.taskType);
    const lastTwoTypes = executionLog.slice(3, 5).map((item) => item.taskType);

    assert.deepEqual(firstThreeTypes, [
      'SEND_TG_MESSAGE',
      'SEND_TG_MESSAGE',
      'SEND_TG_MESSAGE',
    ]);
    assert.deepEqual(lastTwoTypes, ['APPLY_VACANCY', 'APPLY_VACANCY']);

    const finalRecords = ctx.db.select().from(taskQueue).limit(10).all();
    assert.equal(finalRecords.length, 5);
    for (const record of finalRecords) {
      assert.equal(record.status, 'completed');
    }
  } finally {
    ctx.close();
    cleanDbFiles(dbFileName);
  }
});

test('Crash Recovery: recoverStaleProcessingTasks recovers processing tasks back to pending', () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);

    const enqRes = queue.enqueue({
      taskType: 'SYNC_NEGOTIATIONS',
      payload: { mode: 'full' },
    });
    assert.equal(enqRes.error, null);
    const task = enqRes.data!;

    const claimed = queue.claimNextPending();
    assert.equal(claimed.error, null);
    assert.equal(claimed.data?.id, task.id);
    assert.equal(claimed.data?.status, 'processing');
    assert.equal(claimed.data?.attempts, 1);

    const nextClaimBeforeRecovery = queue.claimNextPending();
    assert.equal(nextClaimBeforeRecovery.data, null);

    const recoveryRes = queue.recoverStaleProcessingTasks();
    assert.equal(recoveryRes.error, null);
    assert.equal(recoveryRes.data, 1);

    const recovered = queue.getTaskById(task.id);
    assert.equal(recovered?.status, 'pending');

    const claimedAfterRecovery = queue.claimNextPending();
    assert.equal(claimedAfterRecovery.error, null);
    assert.equal(claimedAfterRecovery.data?.id, task.id);
    assert.equal(claimedAfterRecovery.data?.status, 'processing');
    assert.equal(claimedAfterRecovery.data?.attempts, 2);
  } finally {
    ctx.close();
  }
});

test('Retry and Max Attempts: increments attempts and transitions to failed on max retries', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue, {
      tgRateLimitMs: 0,
      retryDelayMs: 0,
    });

    let executionCount = 0;
    worker.registerHandler('GENERATE_AI_REPLY', async () => {
      executionCount++;
      return { data: null, error: 'Temporary network error' };
    });

    const enq = queue.enqueue({
      taskType: 'GENERATE_AI_REPLY',
      payload: { promptId: 101 },
    });
    assert.equal(enq.error, null);
    const taskId = enq.data!.id;

    const tick1 = await worker.runTick();
    assert.equal(tick1.error, 'Temporary network error');
    assert.equal(tick1.data?.attempts, 1);
    assert.equal(tick1.data?.status, 'pending');
    assert.equal(tick1.data?.lastError, 'Temporary network error');

    const tick2 = await worker.runTick();
    assert.equal(tick2.error, 'Temporary network error');
    assert.equal(tick2.data?.attempts, 2);
    assert.equal(tick2.data?.status, 'pending');

    const tick3 = await worker.runTick();
    assert.equal(tick3.error, 'Temporary network error');
    assert.equal(tick3.data?.attempts, 3);
    assert.equal(tick3.data?.status, 'failed');

    const tick4 = await worker.runTick();
    assert.equal(tick4.error, null);
    assert.equal(tick4.data, null);

    assert.equal(executionCount, 3);

    const finalTask = queue.getTaskById(taskId);
    assert.equal(finalTask?.status, 'failed');
    assert.equal(finalTask?.attempts, 3);
  } finally {
    ctx.close();
  }
});

test('Captcha Pause and Resume: paused_captcha suspends APPLY_VACANCY while allowing priority tasks', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue, {
      tgRateLimitMs: 0,
      retryDelayMs: 0,
    });

    let shouldSucceed = false;
    const completedTasks: string[] = [];

    worker.registerHandler('APPLY_VACANCY', async (task) => {
      if (!shouldSucceed) {
        return { data: null, error: 'CAPTCHA_REQUIRED' };
      }
      completedTasks.push(`apply-${task.id}`);
      return { data: 'completed', error: null };
    });

    worker.registerHandler('SEND_TG_MESSAGE', async (task) => {
      completedTasks.push(`tg-${task.id}`);
      return { data: 'completed', error: null };
    });

    const enq1 = queue.enqueue({
      taskType: 'APPLY_VACANCY',
      payload: { vacancyId: 'job-1' },
    });
    const enq2 = queue.enqueue({
      taskType: 'APPLY_VACANCY',
      payload: { vacancyId: 'job-2' },
    });

    assert.equal(enq1.error, null);
    assert.equal(enq2.error, null);

    const tick1 = await worker.runTick();
    assert.equal(tick1.error, null);
    assert.equal(tick1.data?.status, 'paused_captcha');
    assert.equal(tick1.data?.lastError, 'CAPTCHA_REQUIRED');
    assert.equal(queue.hasPausedCaptchaTask(), true);

    const tick2 = await worker.runTick();
    assert.equal(tick2.error, null);
    assert.equal(tick2.data, null);

    const task2BeforeTg = queue.getTaskById(enq2.data!.id);
    assert.equal(task2BeforeTg?.status, 'pending');

    const enqTg = queue.enqueue({
      taskType: 'SEND_TG_MESSAGE',
      payload: { text: 'Alert: Captcha required' },
    });
    assert.equal(enqTg.error, null);

    const tick3 = await worker.runTick();
    assert.equal(tick3.error, null);
    assert.equal(tick3.data?.id, enqTg.data!.id);
    assert.equal(tick3.data?.status, 'completed');
    assert.deepEqual(completedTasks, [`tg-${enqTg.data!.id}`]);

    const resumeRes = queue.resumePausedCaptchaTasks();
    assert.equal(resumeRes.error, null);
    assert.equal(resumeRes.data, 1);
    assert.equal(queue.hasPausedCaptchaTask(), false);

    const resumedTask1 = queue.getTaskById(enq1.data!.id);
    assert.equal(resumedTask1?.status, 'pending');
    assert.equal(resumedTask1?.attempts, 0);

    shouldSucceed = true;

    const drainRes = await worker.drainAllDue(10);
    assert.equal(drainRes.error, null);
    assert.equal(drainRes.data, 2);

    assert.equal(queue.getTaskById(enq1.data!.id)?.status, 'completed');
    assert.equal(queue.getTaskById(enq2.data!.id)?.status, 'completed');
    assert.equal(completedTasks.length, 3);
  } finally {
    ctx.close();
  }
});

test('Rate limiting spacing: SEND_TG_MESSAGE invokes sleep when triggered consecutively', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const sleeps: number[] = [];

    const worker = new QueueWorkerService(queue, {
      tgRateLimitMs: 500,
      customSleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    worker.registerHandler('SEND_TG_MESSAGE', async () => {
      return { data: 'completed', error: null };
    });

    queue.enqueue({ taskType: 'SEND_TG_MESSAGE', payload: { msg: 1 } });
    queue.enqueue({ taskType: 'SEND_TG_MESSAGE', payload: { msg: 2 } });

    await worker.runTick();
    assert.equal(sleeps.length, 0);

    await worker.runTick();
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > 0 && sleeps[0] <= 500);
  } finally {
    ctx.close();
  }
});

test('Missing handler: marks task failed immediately with error message', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue);

    const enq = queue.enqueue({
      taskType: 'SYNC_NEGOTIATIONS',
      payload: {},
    });
    assert.equal(enq.error, null);

    const tickRes = await worker.runTick();
    assert.equal(tickRes.error, 'No handler registered for SYNC_NEGOTIATIONS');
    assert.equal(tickRes.data?.status, 'failed');
    assert.equal(
      tickRes.data?.lastError,
      'No handler registered for SYNC_NEGOTIATIONS'
    );
  } finally {
    ctx.close();
  }
});

test('Jitter scheduling and countPendingTasks', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue, {
      baseJitterMinutes: 2,
      jitterRangeMinutes: 1,
      enableApplyJitterReschedule: true,
      tgRateLimitMs: 0,
    });

    assert.equal(queue.countPendingTasks(), 0);

    const enq = queue.enqueueWithJitter({ role: 'dev' }, 2, 1);
    assert.equal(enq.error, null);
    assert.ok(enq.data);
    assert.equal(enq.data.taskType, 'APPLY_VACANCY');

    const scheduledDate = new Date(enq.data.scheduledFor).getTime();
    assert.ok(scheduledDate > Date.now());

    assert.equal(queue.countPendingTasks(), 1);

    const enqWorker = worker.enqueueApplyWithJitter({ role: 'qa' }, 1, 0);
    assert.equal(enqWorker.error, null);
    assert.ok(enqWorker.data);
    assert.equal(queue.countPendingTasks(), 2);
  } finally {
    ctx.close();
  }
});

test('Worker start and stop lifecycle', async () => {
  const ctx = createDatabaseContext(':memory:');
  try {
    const queue = new SqliteQueueService(ctx.db, ctx.sqlite);
    const worker = new QueueWorkerService(queue, {
      pollIntervalMs: 50,
      tgRateLimitMs: 0,
    });

    let executed = 0;
    worker.registerHandler('SEND_TG_MESSAGE', async () => {
      executed++;
      return { data: 'completed', error: null };
    });

    queue.enqueue({ taskType: 'SEND_TG_MESSAGE', payload: { a: 1 } });

    assert.equal(worker.getIsRunning(), false);
    worker.start();
    assert.equal(worker.getIsRunning(), true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(executed, 1);

    await worker.stop();
    assert.equal(worker.getIsRunning(), false);

    queue.enqueue({ taskType: 'SEND_TG_MESSAGE', payload: { a: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(executed, 1);
  } finally {
    ctx.close();
  }
});

test('TASK_PRIORITY constants align with specifications', () => {
  assert.equal(TASK_PRIORITY.SEND_TG_MESSAGE, 10);
  assert.equal(TASK_PRIORITY.SYNC_NEGOTIATIONS, 5);
  assert.equal(TASK_PRIORITY.GENERATE_AI_REPLY, 5);
  assert.equal(TASK_PRIORITY.APPLY_VACANCY, 1);
});
