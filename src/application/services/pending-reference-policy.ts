export interface PendingReferencePolicyOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
}

export class PendingReferencePolicy {
  constructor(private readonly options: PendingReferencePolicyOptions) {}

  computeNextRetryAt(attempts: number, now: Date): Date {
    const exponent = Math.max(0, attempts);
    const delayMs = Math.min(this.options.baseDelayMs * 2 ** exponent, this.options.maxDelayMs);
    return new Date(now.getTime() + delayMs);
  }

  isExhausted(attempts: number, createdAt: Date, now: Date): boolean {
    if (attempts >= this.options.maxAttempts) {
      return true;
    }
    return now.getTime() - createdAt.getTime() >= this.options.ttlMs;
  }
}
