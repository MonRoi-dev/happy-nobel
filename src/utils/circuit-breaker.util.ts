export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  nowFn?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;

  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public canExecute(): boolean {
    if (this.state === 'OPEN') {
      const now = this.nowFn();
      if (now - this.openedAt >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
  }

  public recordFailure(): boolean {
    const now = this.nowFn();
    if (this.state === 'OPEN' && now - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
    }

    this.consecutiveFailures++;
    const previousState = this.state;

    if (previousState === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = now;
      return previousState !== 'OPEN';
    }

    return false;
  }

  public getState(): CircuitBreakerState {
    if (this.state === 'OPEN' && this.nowFn() - this.openedAt >= this.cooldownMs) {
      return 'HALF_OPEN';
    }
    return this.state;
  }

  public reset(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
  }
}
