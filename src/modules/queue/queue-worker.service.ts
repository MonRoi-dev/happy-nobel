import type { TaskQueueRecord, TaskType } from '../../db/schema.ts';
import type { SafeResult } from '../config-store/index.ts';
import type { ISqliteQueueService } from './sqlite-queue.service.ts';

export type QueueTaskOutcome = 'completed' | 'paused_captcha';

export type QueueTaskHandler = (
  task: TaskQueueRecord
) => Promise<SafeResult<QueueTaskOutcome>>;

export interface QueueWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly tgRateLimitMs?: number;
  readonly baseJitterMinutes?: number;
  readonly jitterRangeMinutes?: number;
  readonly enableApplyJitterReschedule?: boolean;
  readonly customSleep?: (ms: number) => Promise<void>;
  readonly retryDelayMs?: number;
}

export class QueueWorkerService {
  private isRunning = false;
  private isProcessingTick = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTgSentAtMs = 0;
  private readonly queueService: ISqliteQueueService;
  private readonly handlers = new Map<TaskType, QueueTaskHandler>();
  private readonly pollIntervalMs: number;
  private readonly tgRateLimitMs: number;
  private readonly baseJitterMinutes: number;
  private readonly jitterRangeMinutes: number;
  private readonly enableApplyJitterReschedule: boolean;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly retryDelayMs: number;

  constructor(
    queueService: ISqliteQueueService,
    options: QueueWorkerOptions = {}
  ) {
    this.queueService = queueService;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.tgRateLimitMs = options.tgRateLimitMs ?? 1000;
    this.baseJitterMinutes = options.baseJitterMinutes ?? 3;
    this.jitterRangeMinutes = options.jitterRangeMinutes ?? 2;
    this.enableApplyJitterReschedule = options.enableApplyJitterReschedule ?? false;
    this.sleepFn =
      options.customSleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
  }

  public registerHandler(taskType: TaskType, handler: QueueTaskHandler): void {
    this.handlers.set(taskType, handler);
  }

  public getHandler(taskType: TaskType): QueueTaskHandler | undefined {
    return this.handlers.get(taskType);
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.queueService.recoverStaleProcessingTasks();
    this.pollTimer = setInterval(() => {
      void this.runTick();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  public async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
  }

  public async runTick(): Promise<SafeResult<TaskQueueRecord | null>> {
    if (this.isProcessingTick) {
      return { data: null, error: null };
    }

    this.isProcessingTick = true;
    try {
      const claimRes = this.queueService.claimNextPending();
      if (claimRes.error) {
        return { data: null, error: claimRes.error };
      }

      const task = claimRes.data;
      if (!task) {
        return { data: null, error: null };
      }

      const handler = this.handlers.get(task.taskType as TaskType);
      if (!handler) {
        const errorMsg = `No handler registered for ${task.taskType}`;
        this.queueService.markFailedOrRetry(task.id, errorMsg, 0, 1);
        return {
          data: this.queueService.getTaskById(task.id),
          error: errorMsg,
        };
      }

      if (
        task.taskType === 'SEND_TG_MESSAGE' &&
        this.tgRateLimitMs > 0 &&
        this.lastTgSentAtMs > 0
      ) {
        const elapsed = Date.now() - this.lastTgSentAtMs;
        const waitMs = this.tgRateLimitMs - elapsed;
        if (waitMs > 0) {
          await this.sleepFn(waitMs);
        }
      }

      let res: SafeResult<QueueTaskOutcome>;
      try {
        res = await handler(task);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Handler threw an unhandled exception';
        res = { data: null, error: message };
      }

      if (task.taskType === 'SEND_TG_MESSAGE') {
        this.lastTgSentAtMs = Date.now();
      }

      if (res.error === 'CAPTCHA_REQUIRED' || res.data === 'paused_captcha') {
        this.queueService.pauseForCaptcha(task.id, res.error ?? 'CAPTCHA_REQUIRED');
        return {
          data: this.queueService.getTaskById(task.id),
          error: null,
        };
      }

      if (res.error) {
        this.queueService.markFailedOrRetry(
          task.id,
          res.error,
          this.retryDelayMs
        );
        return {
          data: this.queueService.getTaskById(task.id),
          error: res.error,
        };
      }

      this.queueService.markCompleted(task.id);

      if (task.taskType === 'APPLY_VACANCY' && this.enableApplyJitterReschedule) {
        this.queueService.reschedulePendingApplyTasksWithJitter?.(
          this.baseJitterMinutes,
          this.jitterRangeMinutes
        );
      }

      return {
        data: this.queueService.getTaskById(task.id),
        error: null,
      };
    } finally {
      this.isProcessingTick = false;
    }
  }

  public async drainAllDue(maxIterations = 100): Promise<SafeResult<number>> {
    let processed = 0;
    try {
      while (processed < maxIterations) {
        const tickRes = await this.runTick();
        if (tickRes.error && !tickRes.data) {
          return { data: processed, error: tickRes.error };
        }
        if (!tickRes.data) {
          break;
        }
        processed++;
      }
      return { data: processed, error: null };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to drain due tasks';
      return { data: processed, error: message };
    }
  }

  public enqueueApplyWithJitter<TPayload = unknown>(
    payload: TPayload,
    baseMinutes = this.baseJitterMinutes,
    jitterRangeMinutes = this.jitterRangeMinutes
  ): SafeResult<TaskQueueRecord> {
    if (!this.queueService.enqueueWithJitter) {
      return this.queueService.enqueue({
        taskType: 'APPLY_VACANCY',
        payload,
      });
    }
    return this.queueService.enqueueWithJitter(
      payload,
      baseMinutes,
      jitterRangeMinutes
    );
  }
}
