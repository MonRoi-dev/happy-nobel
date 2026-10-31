import { stderr, stdout } from 'node:process';
import { agentLogger, type AgentLogModule } from '../modules/logger/index.ts';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

const BOT_TOKEN_PATTERN = /(?:bot)?\d{6,15}:[A-Za-z0-9_-]{20,}/g;

export function redactSensitiveText(text: string): string {
  return text.replace(BOT_TOKEN_PATTERN, 'bot[REDACTED_BOT_TOKEN]');
}

export function formatErrorDetails(err: unknown): string {
  if (!err) {
    return '';
  }

  if (err instanceof Error) {
    const parts: string[] = [err.message];
    const errRecord = err as unknown as Record<string, unknown>;

    if (errRecord.error instanceof Error) {
      const nested = errRecord.error as Error & { code?: string; errno?: string };
      parts.push(nested.message);
      if (nested.code) {
        parts.push(`code=${nested.code}`);
      }
    } else if (err.cause instanceof Error) {
      parts.push(err.cause.message);
    }

    const rawCode = typeof errRecord.code === 'string' ? errRecord.code : null;
    if (rawCode) {
      parts.push(`code=${rawCode}`);
    }

    return redactSensitiveText(parts.filter(Boolean).join(' | '));
  }

  return redactSensitiveText(String(err));
}

function formatLocalTimestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function mapScopeToAgentModule(scope: string): AgentLogModule {
  const normalized = scope.toUpperCase();
  if (normalized === 'SYSTEM') {
    return 'SYSTEM';
  }
  if (normalized === 'HHHYBRID' || normalized === 'HH_BROWSER') {
    return 'HH_BROWSER';
  }
  if (normalized === 'HHMESSAGING' || normalized === 'HH_MESSAGING') {
    return 'HH_MESSAGING';
  }
  if (normalized === 'LLM' || normalized === 'LLM_SERVICE') {
    return 'LLM_SERVICE';
  }
  if (normalized === 'TELEGRAM' || normalized === 'TELEGRAM_BOT') {
    return 'TELEGRAM_BOT';
  }
  if (normalized === 'SCHEDULER') {
    return 'SCHEDULER';
  }
  return 'DB';
}

export function createLogger(scope: string): Logger {
  const agentModule = mapScopeToAgentModule(scope);

  return {
    info(message: string): void {
      const safeMsg = redactSensitiveText(message);
      stdout.write(`[${formatLocalTimestamp()}] [INFO] [${scope}] ${safeMsg}\n`);
      agentLogger.logInfo({
        module: agentModule,
        action: scope,
        message,
      });
    },
    warn(message: string): void {
      const safeMsg = redactSensitiveText(message);
      stdout.write(`[${formatLocalTimestamp()}] [WARN] [${scope}] ${safeMsg}\n`);
      agentLogger.logWarn({
        module: agentModule,
        action: scope,
        message,
      });
    },
    error(message: string, err?: unknown): void {
      const safeMsg = redactSensitiveText(message);
      const details = formatErrorDetails(err);
      const suffix = details ? ` — ${details}` : '';
      stderr.write(`[${formatLocalTimestamp()}] [ERROR] [${scope}] ${safeMsg}${suffix}\n`);
      agentLogger.logError({
        module: agentModule,
        action: scope,
        message,
        error: err,
        hint: details.length > 0 ? details : safeMsg,
      });
    },
  };
}
