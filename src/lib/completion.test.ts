import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completionPercent,
  newThresholds,
  parseCampaignLeadStats,
  parseSentCount,
  thresholdsReached,
} from "./completion.js";

describe("completion", () => {
  it("parses Smartlead campaign lead totals", () => {
    const stats = parseCampaignLeadStats({
      data: { total_leads: 1000, leads_contacted: 750, leads_replied: 40 },
    });
    assert.ok(stats);
    assert.equal(stats.total, 1000);
    assert.equal(stats.contacted, 750);
    assert.equal(stats.remaining, 250);
    assert.equal(completionPercent(stats), 75);
  });

  it("uses not_started when contacted is missing", () => {
    const stats = parseCampaignLeadStats({
      campaign_lead_stats: { total: 200, not_started: 50 },
    });
    assert.ok(stats);
    assert.equal(stats.contacted, 150);
    assert.equal(completionPercent(stats), 75);
  });

  it("uses Smartlead analytics drafted_count as remaining", () => {
    const stats = parseCampaignLeadStats({
      total_count: "2038",
      drafted_count: "254",
      sent_count: "0",
      unique_sent_count: "1784",
    });
    assert.ok(stats);
    assert.equal(stats.total, 2038);
    assert.equal(stats.remaining, 254);
    assert.equal(stats.contacted, 1784);
  });

  it("returns 50/75/90/100 crossings only once", () => {
    assert.deepEqual(thresholdsReached(49.9, [50, 75, 90, 100]), []);
    assert.deepEqual(thresholdsReached(50, [50, 75, 90, 100]), [50]);
    assert.deepEqual(thresholdsReached(90, [50, 75, 90, 100]), [50, 75, 90]);
    assert.deepEqual(thresholdsReached(99.6, [50, 75, 90, 100]), [50, 75, 90, 100]);
    assert.deepEqual(newThresholds(92, [50, 75], [50, 75, 90, 100]), [90]);
  });

  it("reads sent_count from analytics-by-date", () => {
    assert.equal(parseSentCount({ sent_count: "180" }), 180);
    assert.equal(parseSentCount({ data: { total_sent: 12 } }), 12);
  });
});
