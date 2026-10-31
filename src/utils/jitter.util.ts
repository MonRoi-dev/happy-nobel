import { randomInt } from 'node:crypto';

export const MIN_JITTER_DELAY_MS = 60_000;

export function calculateJitterDelayMs(
  baseMinutes = 3,
  jitterRangeMinutes = 2
): number {
  const baseMs = Math.round(baseMinutes * 60_000);
  const rangeMs = Math.max(0, Math.round(jitterRangeMinutes * 60_000));
  const offsetMs = rangeMs > 0 ? randomInt(-rangeMs, rangeMs + 1) : 0;
  const subSecondEntropyMs = randomInt(0, 1000);
  const clampedBase = Math.max(MIN_JITTER_DELAY_MS, baseMs + offsetMs);
  return clampedBase + subSecondEntropyMs;
}

export function calculateNextRunWithJitter(
  baseMinutes = 3,
  jitterRangeMinutes = 2,
  nowMs = Date.now()
): Date {
  const delayMs = calculateJitterDelayMs(baseMinutes, jitterRangeMinutes);
  return new Date(nowMs + delayMs);
}
