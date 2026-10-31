import type { SafeResult } from '../config-store/index.ts';
import type { CircuitBreaker } from '../../utils/circuit-breaker.util.ts';
import type {
  IHhBrowserCaptchaService,
  IHhMessagingService,
} from '../hh-hybrid/index.ts';
import type { ISqliteQueueService } from '../queue/index.ts';

export interface SchedulerOptions {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly autoApplyCronPattern?: string;
  readonly syncNegotiationsCronPattern?: string;
  readonly customSleep?: (ms: number) => Promise<void>;
  readonly autoBumpCronPattern?: string;
  readonly manualApprovalDelayMs?: number;
  readonly maxPendingApprovals?: number;
  readonly hhMessaging?: IHhMessagingService;
  readonly syncUnreadMessagesCronPattern?: string;
  readonly captchaService?: IHhBrowserCaptchaService;
  readonly queueService?: ISqliteQueueService;
  readonly hhCircuitBreaker?: CircuitBreaker;
  readonly circuitBreakerThreshold?: number;
  readonly circuitBreakerCooldownMs?: number;
}

export interface AutoApplyCycleSummary {
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly limitReached: boolean;
  readonly failedCount?: number;
}

export interface SyncNotificationsSummary {
  readonly syncedUpdatedCount: number;
  readonly notifiedCount: number;
}

export interface SingleApplicationResult {
  readonly applied: boolean;
  readonly queuedForApproval?: boolean;
  readonly companyName?: string;
  readonly positionTitle?: string;
  readonly salaryText?: string;
  readonly vacancyUrl?: string;
}

export interface ISchedulerService {
  start(): Promise<void>;
  stop(): void;
  handleAutoApplyToggled(enabled: boolean): Promise<void>;
  handleDailyLimitUpdated(newLimit: number): Promise<void>;
  runAutoApplyCycle(): Promise<SafeResult<AutoApplyCycleSummary>>;
  runNegotiationsSyncAndNotify(): Promise<SafeResult<SyncNotificationsSummary>>;
  runAutoBumpResume(): Promise<SafeResult<'bumped' | 'not_ready' | 'disabled'>>;
  runUnreadMessagesSync?(): Promise<SafeResult<{ checkedCount: number; notifiedCount: number }>>;
  checkLlmAvailabilityAndNotify(): Promise<SafeResult<boolean>>;
  runDailyDigestJob?(): Promise<void>;
  countTodayApplications(): number;
  countPendingApprovals(): number;
}
