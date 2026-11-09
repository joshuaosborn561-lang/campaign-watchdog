import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SmartleadLimiter } from "../lib/smartlead-limiter.js";
import {
  ForbiddenCampaignStatusError,
  SmartleadClient,
  assertAllowedCampaignStatus,
  isForbiddenCampaignStatus,
} from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchSpy(): { calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

function fastClient(): SmartleadClient {
  return new SmartleadClient("test-key", {
    limiter: new SmartleadLimiter({ maxPerMinute: 0, minGapMs: 0, minRateLimitPauseMs: 0 }),
  });
}

describe("Smartlead campaign status guard", () => {
  it("classifies PAUSED and STOPPED as forbidden in any case", () => {
    assert.equal(isForbiddenCampaignStatus("PAUSED"), true);
    assert.equal(isForbiddenCampaignStatus("paused"), true);
    assert.equal(isForbiddenCampaignStatus("STOPPED"), true);
    assert.equal(isForbiddenCampaignStatus("stopped"), true);
    assert.equal(isForbiddenCampaignStatus("START"), false);
    assert.equal(isForbiddenCampaignStatus("ACTIVE"), false);
  });

  it("throws and does not treat PAUSED or STOPPED as allowed", () => {
    assert.throws(
      () => assertAllowedCampaignStatus(88, "PAUSED"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError &&
        error.campaignId === 88 &&
        error.status === "PAUSED",
    );
    assert.throws(
      () => assertAllowedCampaignStatus(88, "stopped"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError && error.status === "STOPPED",
    );
    assert.equal(assertAllowedCampaignStatus(88, "START"), "START");
  });

  it("refuses PAUSED without calling the Smartlead API", async () => {
    const { calls } = installFetchSpy();
    const client = fastClient();
    await assert.rejects(
      () => client.updateCampaignStatus(101, "PAUSED"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError &&
        /refused Smartlead status change to PAUSED/.test(error.message),
    );
    assert.deepEqual(calls, []);
  });

  it("refuses STOPPED without calling the Smartlead API", async () => {
    const { calls } = installFetchSpy();
    const client = fastClient();
    await assert.rejects(
      () => client.updateCampaignStatus(102, "STOPPED"),
      ForbiddenCampaignStatusError,
    );
    assert.deepEqual(calls, []);
  });

  it("allows START through to Smartlead", async () => {
    const { calls } = installFetchSpy();
    const client = fastClient();
    const result = await client.updateCampaignStatus(103, "START");
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /campaigns\/103\/status/);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.body, JSON.stringify({ status: "START" }));
  });
});

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

describe("Smartlead 429 backoff", () => {
  it("waits for Retry-After and does not send the retry until then", async () => {
    const clock = manualClock();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limit" }), {
          status: 429,
          headers: { "Retry-After": "2", "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([{ id: 7, name: "Acme", status: "ACTIVE" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new SmartleadClient("test-key", {
      maxRetries: 2,
      limiter: new SmartleadLimiter({
        maxPerMinute: 100,
        minGapMs: 0,
        minRateLimitPauseMs: 0,
        now: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
      }),
    });
    const rows = await client.listCampaigns();
    assert.equal(calls, 2);
    assert.equal(rows[0]?.id, 7);
    assert.ok(clock.now() >= 2000);
  });
});
