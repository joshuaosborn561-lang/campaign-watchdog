import { sleep as defaultSleep } from "./http.js";

/**
 * Process-wide cap for Watchdog's Smartlead calls.
 *
 * The admin API allows 200 requests/minute for the whole account. The
 * deliverability wizard already targets about 150 of those. Watchdog stays
 * on a much smaller budget so a 15-minute pass cannot burst the shared cap.
 * A 429 pauses every waiter, using Retry-After when Smartlead sends one.
 */
export interface SmartleadLimiterOptions {
  /** Max request starts in the rolling window. 0 disables the cap. */
  maxPerMinute?: number;
  /** How many Smartlead calls may be in flight at once. */
  concurrency?: number;
  /** Minimum time between request starts. */
  minGapMs?: number;
  /** Rolling window for `maxPerMinute`. */
  windowMs?: number;
  /** Cap on the exponential backoff used when Retry-After is absent. */
  maxBackoffMs?: number;
  /** Floor applied to every 429 pause so a 0 Retry-After cannot hot-loop. */
  minRateLimitPauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxPerMinute: 30,
  concurrency: 2,
  minGapMs: 200,
  windowMs: 60_000,
  maxBackoffMs: 30_000,
  minRateLimitPauseMs: 250,
};

export class SmartleadLimiter {
  private readonly maxPerMinute: number;
  private readonly concurrency: number;
  private readonly minGapMs: number;
  private readonly windowMs: number;
  private readonly maxBackoffMs: number;
  private readonly minRateLimitPauseMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private inflight = 0;
  private waiters: Array<() => void> = [];
  private pausedUntil = 0;
  private lastStartAt = 0;
  private starts: number[] = [];
  private streak = 0;

  constructor(options: SmartleadLimiterOptions = {}) {
    this.maxPerMinute = options.maxPerMinute ?? DEFAULTS.maxPerMinute;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULTS.concurrency);
    this.minGapMs = Math.max(0, options.minGapMs ?? DEFAULTS.minGapMs);
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.minRateLimitPauseMs = Math.max(0, options.minRateLimitPauseMs ?? DEFAULTS.minRateLimitPauseMs);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Pause every later call. `retryAfterMs` comes from the Retry-After header. */
  noteRateLimit(retryAfterMs?: number): void {
    this.streak += 1;
    const exponential = Math.min(this.maxBackoffMs, 1_000 * 2 ** Math.min(this.streak - 1, 5));
    const requested =
      retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : exponential;
    const pause = Math.max(this.minRateLimitPauseMs, requested);
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause);
  }

  noteSuccess(): void {
    this.streak = 0;
  }

  snapshot(): { inflight: number; waiting: number; pausedForMs: number; requestsInWindow: number } {
    this.prune(this.now());
    return {
      inflight: this.inflight,
      waiting: this.waiters.length,
      pausedForMs: Math.max(0, this.pausedUntil - this.now()),
      requestsInWindow: this.starts.length,
    };
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitUntilReady();
      this.lastStartAt = this.now();
      this.starts.push(this.lastStartAt);
      const value = await fn();
      this.noteSuccess();
      return value;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inflight < this.concurrency) {
      this.inflight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.starts.length && this.starts[0]! < cutoff) {
      this.starts = this.starts.filter((at) => at >= cutoff);
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (this.maxPerMinute <= 0 && this.minGapMs <= 0) {
      const pause = this.pausedUntil - this.now();
      if (pause > 0) await this.sleep(pause);
      return;
    }
    for (;;) {
      const now = this.now();
      const pause = this.pausedUntil - now;
      if (pause > 0) {
        await this.sleep(pause);
        continue;
      }
      this.prune(now);
      if (this.maxPerMinute > 0 && this.starts.length >= this.maxPerMinute) {
        const oldest = this.starts[0] ?? now;
        const wait = oldest + this.windowMs - now + 5;
        await this.sleep(Math.max(1, wait));
        continue;
      }
      const gap = this.lastStartAt + this.minGapMs - now;
      if (gap > 0) {
        await this.sleep(gap);
        continue;
      }
      return;
    }
  }
}
