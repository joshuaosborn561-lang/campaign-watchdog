import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MAX_RATE_LIMIT_WAIT_MS, apiRequest, retryDelayMs } from "./http.js";

const res = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

describe("retryDelayMs (429 backoff)", () => {
  it("waits out Smartlead's Retry-After: 60 instead of giving up after ~7.5s", () => {
    assert.equal(retryDelayMs(res(429, { "retry-after": "60" }), 0), 60_250);
  });

  it("caps any single wait at ~65s", () => {
    assert.equal(retryDelayMs(res(429, { "retry-after": "600" }), 0), MAX_RATE_LIMIT_WAIT_MS);
  });

  it("uses X-RateLimit-Reset (epoch seconds) when Retry-After is absent", () => {
    assert.equal(retryDelayMs(res(429, { "x-ratelimit-reset": "1794505476" }), 0, 1_794_505_466_000), 10_250);
  });

  it("waits at least 15s on a bare 429 and keeps exponential backoff for 5xx", () => {
    assert.equal(retryDelayMs(res(429), 0), 15_000);
    assert.equal(retryDelayMs(res(503), 2), 2_000);
  });
});

describe("apiRequest 429 retry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries a 429 and returns the later success", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ message: "rate limit" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const out = await apiRequest<{ ok: boolean }>("https://x.test/", "k", "ping", { retries: 6 });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls, 2);
  });
});
