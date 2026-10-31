import type { Page } from 'playwright';

export type LogSeverity = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export type AgentLogModule =
  | 'HH_BROWSER'
  | 'HH_MESSAGING'
  | 'LLM_SERVICE'
  | 'TELEGRAM_BOT'
  | 'SCHEDULER'
  | 'DB'
  | 'SYSTEM';

export interface PlaywrightFailureContext {
  readonly currentUrl: string;
  readonly failedSelector?: string;
  readonly httpStatus?: number;
  readonly pageTitle?: string;
  readonly domSnippet?: string;
  readonly screenshotPath?: string;
}

export interface AgentLogErrorPayload {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly DiagnosticHintForAgent: string;
}

export interface AgentLogEntry {
  readonly timestamp: string;
  readonly level: LogSeverity;
  readonly traceId: string;
  readonly module: AgentLogModule;
  readonly action: string;
  readonly message: string;
  readonly durationMs?: number;
  readonly metadata?: Record<string, unknown>;
  readonly error?: AgentLogErrorPayload;
  readonly playwrightContext?: PlaywrightFailureContext;
}

export interface LogPlaywrightErrorParams {
  readonly traceId: string;
  readonly module: AgentLogModule;
  readonly action: string;
  readonly error: unknown;
  readonly page?: Page;
  readonly failedSelector?: string;
  readonly httpStatus?: number;
  readonly hint: string;
}

export interface IAgentLoggerService {
  createTraceId(): string;
  logInfo(params: {
    traceId?: string;
    module: AgentLogModule;
    action: string;
    message: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): AgentLogEntry;
  logWarn(params: {
    traceId?: string;
    module: AgentLogModule;
    action: string;
    message: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): AgentLogEntry;
  logError(params: {
    traceId?: string;
    module: AgentLogModule;
    action: string;
    message: string;
    error?: unknown;
    hint: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
    playwrightContext?: PlaywrightFailureContext;
    level?: 'ERROR' | 'FATAL';
  }): AgentLogEntry;
  logPlaywrightError(params: LogPlaywrightErrorParams): Promise<AgentLogEntry>;
  readRecentErrors(limit?: number): ReadonlyArray<AgentLogEntry>;
  rotateFileIfNeeded?(filePath: string, incomingBytes?: number): void;
}
