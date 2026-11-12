import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countSentTodayByClient, formatSentCount, type SentTodaySource } from "./sent-today.js";
import { formatClientPulse, rollupClientPulse } from "./pulse.js";

const DAY = "2026-11-12";

function source(opts: {
  dayWise?: (ids: number[]) => { sent: number; bounced: number };
  byDate?: Record<number, unknown>;
}): SentTodaySource & { dayWiseCalls: number[][]; byDateCalls: number[] } {
  const dayWiseCalls: number[][] = [];
  const byDateCalls: number[] = [];
  return {
    dayWiseCalls,
    byDateCalls,
    async getDayWiseTotals(_day, ids) {
      dayWiseCalls.push([...ids]);
      if (!opts.dayWise) throw new Error("429 Account rate limit exceeded");
      return opts.dayWise(ids);
    },
    async getCampaignAnalyticsByDate(id) {
      byDateCalls.push(id);
      if (opts.byDate && id in opts.byDate) return opts.byDate[id];
      throw new Error("Account rate limit exceeded. You have exceeded the 200 requests in 1 min limit.");
    },
  };
}

const sg = (id: number) => ({ id, name: `SG ${id}`, clientId: 999, clientName: "SalesGlider" });
const parlay = (id: number) => ({ id, name: `Parlay ${id}`, clientId: 777, clientName: "Parlay" });

describe("countSentTodayByClient", () => {
  it("makes one day-wise call per client over all its campaigns", async () => {
    const src = source({
      dayWise: (ids) => (ids.includes(1) ? { sent: 1082, bounced: 9 } : { sent: 617, bounced: 4 }),
    });
    const result = await countSentTodayByClient({
      source: src,
      day: DAY,
      campaigns: [sg(1), sg(2), parlay(3), parlay(4), parlay(5)],
      log: () => undefined,
    });
    assert.equal(result.calls, 2);
    assert.deepEqual(src.dayWiseCalls, [[1, 2], [3, 4, 5]]);
    assert.equal(src.byDateCalls.length, 0);
    assert.deepEqual(
      [...result.byKey.values()].map((r) => [r.clientName, r.sent, r.bounced, r.unread]),
      [
        ["SalesGlider", 1082, 9, 0],
        ["Parlay", 617, 4, 0],
      ],
    );
  });

  it("chunks long campaign lists and sums the chunks", async () => {
    const src = source({ dayWise: (ids) => ({ sent: ids.length * 10, bounced: 0 }) });
    const result = await countSentTodayByClient({
      source: src,
      day: DAY,
      campaigns: [sg(1), sg(2), sg(3), sg(4), sg(5)],
      chunkSize: 2,
      log: () => undefined,
    });
    assert.deepEqual(src.dayWiseCalls, [[1, 2], [3, 4], [5]]);
    assert.equal([...result.byKey.values()][0].sent, 50);
  });

  it("falls back to per-campaign reads and never turns a failed read into 0", async () => {
    const warnings: string[] = [];
    // Day-wise 429s; #4287124 (the 668-send list) also fails; #2 reads 283.
    const src = source({
      byDate: { 2: { data: [{ date: DAY, sent_count: 283, bounce_count: 3 }] } },
    });
    const result = await countSentTodayByClient({
      source: src,
      day: DAY,
      campaigns: [sg(4287124), sg(2)],
      log: (m) => warnings.push(m),
    });
    const row = [...result.byKey.values()][0];
    assert.equal(row.sent, 283);
    assert.equal(row.unread, 1);
    assert.equal(result.bulkFailures, 1);
    assert.ok(warnings.some((w) => w.includes("#4287124") && w.includes("unread")));
    assert.ok(warnings.some((w) => w.includes("day-wise") && w.includes("falling back")));
  });

  it("treats an empty by-date response as unread, not 0", async () => {
    const src = source({ byDate: { 7: null } });
    const result = await countSentTodayByClient({
      source: src,
      day: DAY,
      campaigns: [sg(7)],
      log: () => undefined,
    });
    assert.equal([...result.byKey.values()][0].unread, 1);
  });
});

describe("incomplete sent rendering", () => {
  it("formats a floor with the unread count", () => {
    assert.equal(formatSentCount(1082), "1,082 sent");
    assert.equal(formatSentCount(283, 1), "≥283 sent (incomplete: 1 campaign unread)");
    assert.equal(formatSentCount(0, 3), "≥0 sent (incomplete: 3 campaigns unread)");
  });

  it("renders the pulse line and total as ≥N when a client has unread campaigns", () => {
    const text = formatClientPulse({
      day: DAY,
      hour: 10,
      bounceWarn: 5,
      clients: rollupClientPulse([
        { clientName: "SalesGlider", clientId: 999, sent: 283, bounced: 3, unread: 1 },
        { clientName: "Parlay", clientId: 777, sent: 617, bounced: 6 },
      ]),
    });
    assert.match(text, /\*SalesGlider\* — ≥283 sent \(incomplete: 1 campaign unread\)/);
    assert.match(text, /\*Parlay\* — 617 sent/);
    assert.match(text, /Total ≥900 sent \(incomplete: 1 campaign unread\)/);
  });
});

describe("day-wise id limit", () => {
  it("never sends more than 100 campaign ids in one call", async () => {
    const src = source({ dayWise: (ids) => ({ sent: ids.length, bounced: 0 }) });
    const many = Array.from({ length: 230 }, (_, i) => sg(i + 1));
    const result = await countSentTodayByClient({
      source: src,
      day: DAY,
      campaigns: many,
      chunkSize: 500,
      log: () => undefined,
    });
    assert.deepEqual(src.dayWiseCalls.map((ids) => ids.length), [100, 100, 30]);
    assert.equal([...result.byKey.values()][0].sent, 230);
  });
});
