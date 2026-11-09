import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmartleadLimiter } from "./smartlead-limiter.js";

function manualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let now = 0;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    queueMicrotask(() => {
      ticking = false;
      if (!waiters.length) return;
      waiters.sort((a, b) => a.at - b.at);
      now = Math.max(now, waiters[0]!.at);
      const ready: Array<() => void> = [];
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]!.at <= now) {
          ready.push(waiters[index]!.resolve);
          waiters.splice(index, 1);
        }
      }
      for (const resolve of ready) resolve();
      if (waiters.length) tick();
    });
  };
  return {
    now: () => now,
    sleep(ms: number) {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push({ at: now + ms, resolve });
        tick();
      });
    },
  };
}

describe("SmartleadLimiter", () => {
  it("holds a second call until the first releases the only slot", async () => {
    const limiter = new SmartleadLimiter({
      concurrency: 1,
      minGapMs: 0,
      maxPerMinute: 0,
      minRateLimitPauseMs: 0,
    });
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let overlap = 0;
    let maxOverlap = 0;
    const first = limiter.schedule(async () => {
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      await hold;
      overlap -= 1;
    });
    const second = limiter.schedule(async () => {
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      overlap -= 1;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(maxOverlap, 1);
    assert.equal(limiter.snapshot().inflight, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(maxOverlap, 1);
  });

  it("does not start a third request inside the same rate window", async () => {
    const clock = manualClock();
    const limiter = new SmartleadLimiter({
      concurrency: 1,
      minGapMs: 0,
      maxPerMinute: 2,
      windowMs: 1_000,
      minRateLimitPauseMs: 0,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    });
    await limiter.schedule(async () => "a");
    await limiter.schedule(async () => "b");
    assert.equal(clock.now(), 0);
    await limiter.schedule(async () => "c");
    assert.ok(clock.now() >= 1_000);
    assert.ok(limiter.snapshot().requestsInWindow <= 2);
  });

  it("pauses every later call for Retry-After", async () => {
    const clock = manualClock();
    const limiter = new SmartleadLimiter({
      concurrency: 2,
      minGapMs: 0,
      maxPerMinute: 100,
      minRateLimitPauseMs: 0,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    });
    limiter.noteRateLimit(5_000);
    let ran = false;
    await limiter.schedule(async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.ok(clock.now() >= 5_000);
  });
});
