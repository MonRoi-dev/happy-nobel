import type { DatabaseSync } from 'node:sqlite';
import { and, asc, desc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index.ts';
import {
  taskQueue,
  type TaskQueueRecord,
  type TaskType,
} from '../../db/schema.ts';
import type { SafeResult } from '../config-store/index.ts';
import { calculateNextRunWithJitter } from '../../utils/jitter.util.ts';

export const TASK_PRIORITY: Readonly<Record<TaskType, number>> = {
  SEND_TG_MESSAGE: 10,
  SYNC_NEGOTIATIONS: 5,
  GENERATE_AI_REPLY: 5,
  APPLY_VACANCY: 1,
};

export const DEFAULT_MAX_TASK_RETRIES = 3;

export interface EnqueueTaskParams<TPayload = unknown> {
  readonly taskType: TaskType;
  readonly payload: TPayload;
  readonly priority?: number;
  readonly delayMs?: number;
  readonly scheduledFor?: string;
}

export interface ISqliteQueueService {
  recoverStaleProcessingTasks(): SafeResult<number>;
  enqueue<TPayload = unknown>(params: EnqueueTaskParams<TPayload>): SafeResult<TaskQueueRecord>;
  claimNextPending(nowIso?: string): SafeResult<TaskQueueRecord | null>;
  markCompleted(taskId: number): SafeResult<boolean>;
  markFailedOrRetry(
    taskId: number,
    errorMessage: string,
    retryDelayMs?: number,
    maxRetries?: number
  ): SafeResult<TaskQueueRecord | null>;
  pauseForCaptcha(taskId: number, reason?: string): SafeResult<boolean>;
  resumePausedCaptchaTasks(): SafeResult<number>;
  hasPausedCaptchaTask(): boolean;
  countPendingTasks(): number;
  getTaskById(taskId: number): TaskQueueRecord | null;
  enqueueWithJitter?<TPayload = unknown>(
    payload: TPayload,
    baseMinutes?: number,
    jitterRangeMinutes?: number
  ): SafeResult<TaskQueueRecord>;
  reschedulePendingApplyTasksWithJitter?(
    baseMinutes?: number,
    jitterRangeMinutes?: number
  ): SafeResult<number>;
  pruneCompletedAndFailedTasks?(olderThanDays?: number): SafeResult<number>;
}

export class SqliteQueueService implements ISqliteQueueService {
  private readonly db: AppDatabase;
  private readonly sqlite?: DatabaseSync;

  constructor(
    db: AppDatabase,
    sqlite?: DatabaseSync
  ) {
    this.db = db;
    this.sqlite = sqlite;
  }

  public recoverStaleProcessingTasks(): SafeResult<number> {
    try {
      const staleRows = this.db
        .select({ id: taskQueue.id })
        .from(taskQueue)
        .where(eq(taskQueue.status, 'processing'))
        .limit(1000)
        .all();

      if (staleRows.length === 0) {
        return { data: 0, error: null };
      }

      const nowIso = new Date().toISOString();
      const ids = staleRows.map((r) => r.id);
      this.db
        .update(taskQueue)
        .set({
          status: 'pending',
          updatedAt: nowIso,
        })
        .where(inArray(taskQueue.id, ids))
        .run();

      return { data: ids.length, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to recover stale processing tasks';
      return { data: null, error: message };
    }
  }

  public enqueue<TPayload = unknown>(
    params: EnqueueTaskParams<TPayload>
  ): SafeResult<TaskQueueRecord> {
    try {
      const priority = params.priority ?? TASK_PRIORITY[params.taskType] ?? 1;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const scheduledFor =
        params.scheduledFor ??
        new Date(now + Math.max(0, params.delayMs ?? 0)).toISOString();
      const payloadJson =
        typeof params.payload === 'string'
          ? params.payload
          : JSON.stringify(params.payload ?? {});

      const inserted = this.db
        .insert(taskQueue)
        .values({
          taskType: params.taskType,
          payloadJson,
          status: 'pending',
          priority,
          attempts: 0,
          lastError: null,
          scheduledFor,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .returning()
        .get();

      if (!inserted) {
        return { data: null, error: 'Failed to insert task queue record' };
      }

      return { data: inserted, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to enqueue task';
      return { data: null, error: message };
    }
  }

  public enqueueWithJitter<TPayload = unknown>(
    payload: TPayload,
    baseMinutes = 3,
    jitterRangeMinutes = 2
  ): SafeResult<TaskQueueRecord> {
    const scheduledFor = calculateNextRunWithJitter(
      baseMinutes,
      jitterRangeMinutes
    ).toISOString();
    return this.enqueue({
      taskType: 'APPLY_VACANCY',
      payload,
      scheduledFor,
    });
  }

  public hasPausedCaptchaTask(): boolean {
    try {
      const row = this.db
        .select({ id: taskQueue.id })
        .from(taskQueue)
        .where(eq(taskQueue.status, 'paused_captcha'))
        .limit(1)
        .get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  public claimNextPending(
    nowIso = new Date().toISOString()
  ): SafeResult<TaskQueueRecord | null> {
    try {
      const claimed = this.db.transaction((tx) => {
        const pausedRow = tx
          .select({ id: taskQueue.id })
          .from(taskQueue)
          .where(eq(taskQueue.status, 'paused_captcha'))
          .limit(1)
          .get();

        const captchaPaused = Boolean(pausedRow);

        const condition = captchaPaused
          ? and(
              eq(taskQueue.status, 'pending'),
              lte(taskQueue.scheduledFor, nowIso),
              ne(taskQueue.taskType, 'APPLY_VACANCY')
            )
          : and(
              eq(taskQueue.status, 'pending'),
              lte(taskQueue.scheduledFor, nowIso)
            );

        const candidate = tx
          .select()
          .from(taskQueue)
          .where(condition)
          .orderBy(
            desc(taskQueue.priority),
            asc(taskQueue.scheduledFor),
            asc(taskQueue.id)
          )
          .limit(1)
          .get();

        if (!candidate) {
          return null;
        }

        const updated = tx
          .update(taskQueue)
          .set({
            status: 'processing',
            attempts: candidate.attempts + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(taskQueue.id, candidate.id),
              eq(taskQueue.status, 'pending')
            )
          )
          .returning()
          .get();

        return updated ?? null;
      });

      return { data: claimed, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to claim next pending task';
      return { data: null, error: message };
    }
  }

  public markCompleted(taskId: number): SafeResult<boolean> {
    try {
      const nowIso = new Date().toISOString();
      this.db
        .update(taskQueue)
        .set({
          status: 'completed',
          updatedAt: nowIso,
        })
        .where(eq(taskQueue.id, taskId))
        .run();
      return { data: true, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to mark task completed';
      return { data: null, error: message };
    }
  }

  public markFailedOrRetry(
    taskId: number,
    errorMessage: string,
    retryDelayMs = 5_000,
    maxRetries = DEFAULT_MAX_TASK_RETRIES
  ): SafeResult<TaskQueueRecord | null> {
    try {
      const existing = this.db
        .select()
        .from(taskQueue)
        .where(eq(taskQueue.id, taskId))
        .limit(1)
        .get();

      if (!existing) {
        return { data: null, error: `Task with id ${taskId} not found` };
      }

      const nowIso = new Date().toISOString();
      if (existing.attempts < maxRetries) {
        const scheduledFor = new Date(
          Date.now() + Math.max(0, retryDelayMs)
        ).toISOString();
        const updated = this.db
          .update(taskQueue)
          .set({
            status: 'pending',
            lastError: errorMessage,
            scheduledFor,
            updatedAt: nowIso,
          })
          .where(eq(taskQueue.id, taskId))
          .returning()
          .get();

        return { data: updated ?? null, error: null };
      }

      const updated = this.db
        .update(taskQueue)
        .set({
          status: 'failed',
          lastError: errorMessage,
          updatedAt: nowIso,
        })
        .where(eq(taskQueue.id, taskId))
        .returning()
        .get();

      return { data: updated ?? null, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to mark task failed or retry';
      return { data: null, error: message };
    }
  }

  public pauseForCaptcha(
    taskId: number,
    reason = 'CAPTCHA_REQUIRED'
  ): SafeResult<boolean> {
    try {
      const nowIso = new Date().toISOString();
      this.db
        .update(taskQueue)
        .set({
          status: 'paused_captcha',
          lastError: reason,
          updatedAt: nowIso,
        })
        .where(eq(taskQueue.id, taskId))
        .run();
      return { data: true, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to pause task for captcha';
      return { data: null, error: message };
    }
  }

  public resumePausedCaptchaTasks(): SafeResult<number> {
    try {
      const rows = this.db
        .select()
        .from(taskQueue)
        .where(eq(taskQueue.status, 'paused_captcha'))
        .limit(100)
        .all();

      if (rows.length === 0) {
        return { data: 0, error: null };
      }

      const nowIso = new Date().toISOString();
      for (const row of rows) {
        this.db
          .update(taskQueue)
          .set({
            status: 'pending',
            attempts: Math.max(0, row.attempts - 1),
            scheduledFor: nowIso,
            updatedAt: nowIso,
          })
          .where(eq(taskQueue.id, row.id))
          .run();
      }

      return { data: rows.length, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to resume paused captcha tasks';
      return { data: null, error: message };
    }
  }

  public countPendingTasks(): number {
    try {
      const rows = this.db
        .select({ id: taskQueue.id })
        .from(taskQueue)
        .where(
          inArray(taskQueue.status, [
            'pending',
            'processing',
            'paused_captcha',
          ])
        )
        .limit(1000)
        .all();
      return rows.length;
    } catch {
      return 0;
    }
  }

  public getTaskById(taskId: number): TaskQueueRecord | null {
    try {
      const row = this.db
        .select()
        .from(taskQueue)
        .where(eq(taskQueue.id, taskId))
        .limit(1)
        .get();
      return row ?? null;
    } catch {
      return null;
    }
  }

  public reschedulePendingApplyTasksWithJitter(
    baseMinutes = 3,
    jitterRangeMinutes = 2
  ): SafeResult<number> {
    try {
      const nowIso = new Date().toISOString();
      const rows = this.db
        .select({ id: taskQueue.id })
        .from(taskQueue)
        .where(
          and(
            eq(taskQueue.taskType, 'APPLY_VACANCY'),
            eq(taskQueue.status, 'pending'),
            lte(taskQueue.scheduledFor, nowIso)
          )
        )
        .limit(100)
        .all();

      if (rows.length === 0) {
        return { data: 0, error: null };
      }

      for (const row of rows) {
        const scheduledFor = calculateNextRunWithJitter(
          baseMinutes,
          jitterRangeMinutes
        ).toISOString();
        this.db
          .update(taskQueue)
          .set({
            scheduledFor,
            updatedAt: nowIso,
          })
          .where(eq(taskQueue.id, row.id))
          .run();
      }

      return { data: rows.length, error: null };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to reschedule pending apply tasks with jitter';
      return { data: null, error: message };
    }
  }

  public pruneCompletedAndFailedTasks(olderThanDays = 7): SafeResult<number> {
    try {
      const cutoffMs = Date.now() - Math.max(0, olderThanDays) * 24 * 60 * 60 * 1000;
      const cutoffIso = new Date(cutoffMs).toISOString();

      const candidateRows = this.db
        .select({ id: taskQueue.id })
        .from(taskQueue)
        .where(
          and(
            inArray(taskQueue.status, ['completed', 'failed']),
            lt(taskQueue.updatedAt, cutoffIso)
          )
        )
        .limit(500)
        .all();

      if (candidateRows.length === 0) {
        return { data: 0, error: null };
      }

      const idsToDelete = candidateRows.map((r) => r.id);
      this.db
        .delete(taskQueue)
        .where(inArray(taskQueue.id, idsToDelete))
        .run();

      return { data: idsToDelete.length, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to prune tasks';
      return { data: null, error: message };
    }
  }
}
