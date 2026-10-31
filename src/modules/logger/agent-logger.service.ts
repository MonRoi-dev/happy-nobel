import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { redactSensitiveText } from '../../utils/logger.ts';
import type {
  AgentLogErrorPayload,
  AgentLogEntry,
  AgentLogModule,
  IAgentLoggerService,
  LogPlaywrightErrorParams,
  PlaywrightFailureContext,
} from './agent-logger.types.ts';

export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const RETAIN_LOG_BYTES = 10 * 1024 * 1024;

export interface AgentLoggerOptions {
  readonly logsDir?: string;
  readonly enabled?: boolean;
  readonly maxLogBytes?: number;
  readonly retainLogBytes?: number;
}

export class AgentLoggerService implements IAgentLoggerService {
  private logsDir: string;
  private snapshotsDir: string;
  private debugLogPath: string;
  private errorsLogPath: string;
  private enabled: boolean;
  private maxLogBytes: number;
  private retainLogBytes: number;

  constructor(options?: AgentLoggerOptions) {
    this.logsDir = path.resolve(options?.logsDir ?? path.resolve(process.cwd(), 'logs'));
    this.snapshotsDir = path.join(this.logsDir, 'snapshots');
    this.debugLogPath = path.join(this.logsDir, 'agent-debug.jsonl');
    this.errorsLogPath = path.join(this.logsDir, 'agent-errors.jsonl');
    this.enabled = options?.enabled ?? (process.env.AGENT_LOGS_DISABLED !== 'true');
    this.maxLogBytes = options?.maxLogBytes ?? MAX_LOG_BYTES;
    this.retainLogBytes = options?.retainLogBytes ?? RETAIN_LOG_BYTES;
    this.ensureDirectories();
    if (this.enabled) {
      this.rotateFileIfNeeded(this.debugLogPath);
      this.rotateFileIfNeeded(this.errorsLogPath);
    }
  }

  configure(options: AgentLoggerOptions): void {
    if (options.logsDir !== undefined) {
      this.logsDir = path.resolve(options.logsDir);
      this.snapshotsDir = path.join(this.logsDir, 'snapshots');
      this.debugLogPath = path.join(this.logsDir, 'agent-debug.jsonl');
      this.errorsLogPath = path.join(this.logsDir, 'agent-errors.jsonl');
    }
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    }
    if (options.maxLogBytes !== undefined) {
      this.maxLogBytes = options.maxLogBytes;
    }
    if (options.retainLogBytes !== undefined) {
      this.retainLogBytes = options.retainLogBytes;
    }
    this.ensureDirectories();
    if (this.enabled) {
      this.rotateFileIfNeeded(this.debugLogPath);
      this.rotateFileIfNeeded(this.errorsLogPath);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  createTraceId(): string {
    return randomUUID();
  }

  logInfo(params: {
    traceId?: string;
    module: AgentLogModule;
    action: string;
    message: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): AgentLogEntry {
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      traceId: params.traceId ?? this.createTraceId(),
      module: params.module,
      action: params.action,
      message: redactSensitiveText(params.message),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };

    this.writeEntry(entry);
    return entry;
  }

  logWarn(params: {
    traceId?: string;
    module: AgentLogModule;
    action: string;
    message: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): AgentLogEntry {
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      traceId: params.traceId ?? this.createTraceId(),
      module: params.module,
      action: params.action,
      message: redactSensitiveText(params.message),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };

    this.writeEntry(entry);
    return entry;
  }

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
  }): AgentLogEntry {
    const errorPayload = this.buildErrorPayload(params.error, params.hint, params.message);

    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      level: params.level ?? 'ERROR',
      traceId: params.traceId ?? this.createTraceId(),
      module: params.module,
      action: params.action,
      message: redactSensitiveText(params.message),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      error: errorPayload,
      ...(params.playwrightContext !== undefined ? { playwrightContext: params.playwrightContext } : {}),
    };

    this.writeEntry(entry);
    return entry;
  }

  async logPlaywrightError(params: LogPlaywrightErrorParams): Promise<AgentLogEntry> {
    const safeTraceId = params.traceId.replace(/[^a-zA-Z0-9_-]/g, '_');
    let playwrightContext: PlaywrightFailureContext;

    if (params.page) {
      let currentUrl = 'unknown';
      try {
        currentUrl = params.page.url();
      } catch {
        currentUrl = 'unknown';
      }

      let pageTitle: string | undefined;
      try {
        pageTitle = await params.page.title();
      } catch {
        pageTitle = undefined;
      }

      let domSnippet: string | undefined;
      try {
        let rawContent = '';
        try {
          rawContent = await params.page.locator('body').innerText({ timeout: 2000 });
        } catch {
          try {
            if (typeof params.page.innerHTML === 'function') {
              rawContent = await params.page.innerHTML('body', { timeout: 2000 });
            }
          } catch {
            rawContent = '';
          }
        }

        if (rawContent) {
          const normalized = rawContent.replace(/\s+/g, ' ').trim();
          const redacted = redactSensitiveText(normalized);
          domSnippet = redacted.length > 2000 ? redacted.slice(0, 2000) : redacted;
        }
      } catch {
        domSnippet = undefined;
      }

      let screenshotPath: string | undefined;
      try {
        this.ensureDirectories();
        const screenshotFileName = `${safeTraceId}.png`;
        const absoluteScreenshotPath = path.join(this.snapshotsDir, screenshotFileName);
        await params.page.screenshot({ path: absoluteScreenshotPath });
        screenshotPath = `logs/snapshots/${screenshotFileName}`;
      } catch {
        screenshotPath = undefined;
      }

      playwrightContext = {
        currentUrl,
        failedSelector: params.failedSelector,
        httpStatus: params.httpStatus,
        pageTitle,
        domSnippet,
        screenshotPath,
      };
    } else {
      playwrightContext = {
        currentUrl: 'unknown',
        failedSelector: params.failedSelector,
        httpStatus: params.httpStatus,
      };
    }

    const message = params.error instanceof Error
      ? (params.error.message || `Playwright error in ${params.action}`)
      : typeof params.error === 'string' && params.error.length > 0
        ? params.error
        : `Playwright error in ${params.action}`;

    return this.logError({
      traceId: params.traceId,
      module: params.module,
      action: params.action,
      message,
      error: params.error,
      hint: params.hint,
      playwrightContext,
    });
  }

  readRecentErrors(limit = 5): ReadonlyArray<AgentLogEntry> {
    if (!fs.existsSync(this.errorsLogPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.errorsLogPath, 'utf8');
      const lines = content.split('\n');
      const entries: AgentLogEntry[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as AgentLogEntry;
          if (parsed && typeof parsed === 'object') {
            entries.push(parsed);
          }
        } catch {
        }
      }

      const boundedLimit = Math.max(0, limit);
      if (boundedLimit === 0) {
        return [];
      }

      return entries.slice(-boundedLimit).reverse();
    } catch {
      return [];
    }
  }

  private buildErrorPayload(
    error: unknown,
    hint: string,
    fallbackMessage: string
  ): AgentLogErrorPayload {
    if (error instanceof Error) {
      const errRecord = error as unknown as Record<string, unknown>;
      const code = typeof errRecord.code === 'string' ? errRecord.code : undefined;
      return {
        name: error.name || 'Error',
        message: redactSensitiveText(error.message),
        stack: error.stack ? redactSensitiveText(error.stack) : undefined,
        code,
        DiagnosticHintForAgent: hint,
      };
    }

    if (error !== undefined && error !== null) {
      return {
        name: 'Error',
        message: redactSensitiveText(String(error)),
        DiagnosticHintForAgent: hint,
      };
    }

    return {
      name: 'Error',
      message: redactSensitiveText(fallbackMessage),
      DiagnosticHintForAgent: hint,
    };
  }

  public rotateFileIfNeeded(filePath: string, incomingBytes = 0): void {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }

      const stat = fs.statSync(filePath);
      if (
        stat.size <= this.maxLogBytes &&
        (incomingBytes === 0 || stat.size + incomingBytes <= this.maxLogBytes)
      ) {
        return;
      }

      const bytesToRead = Math.min(stat.size, this.retainLogBytes);
      if (bytesToRead <= 0) {
        return;
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
      } finally {
        fs.closeSync(fd);
      }

      const firstNewlineIdx = buffer.indexOf(0x0a);
      const cleanTail =
        stat.size > bytesToRead && firstNewlineIdx !== -1
          ? buffer.subarray(firstNewlineIdx + 1)
          : buffer;

      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, cleanTail);
      fs.renameSync(tmpPath, filePath);
    } catch {
      try {
        const tmpPath = `${filePath}.tmp`;
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
      }
    }
  }

  private writeEntry(entry: AgentLogEntry): void {
    if (!this.enabled) {
      return;
    }

    try {
      this.ensureDirectories();
      const line = JSON.stringify(entry) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');
      this.rotateFileIfNeeded(this.debugLogPath, lineBytes);
      fs.appendFileSync(this.debugLogPath, line, 'utf8');
      if (entry.level === 'ERROR' || entry.level === 'FATAL') {
        this.rotateFileIfNeeded(this.errorsLogPath, lineBytes);
        fs.appendFileSync(this.errorsLogPath, line, 'utf8');
      }
    } catch {
    }
  }

  private ensureDirectories(): void {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
      if (!fs.existsSync(this.snapshotsDir)) {
        fs.mkdirSync(this.snapshotsDir, { recursive: true });
      }
    } catch {
    }
  }
}

export const agentLogger = new AgentLoggerService();
