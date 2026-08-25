import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAutobounce, parseBounceAutoPauseThreshold } from "./autobounce.js";

describe("autobounce", () => {
  it("reads bounce_auto_pause_threshold from settings", () => {
    assert.equal(parseBounceAutoPauseThreshold({ bounce_auto_pause_threshold: 8 }, 5), 8);
    assert.equal(parseBounceAutoPauseThreshold({}, 5), 5);
  });

  it("detects a Smartlead autobounce pause from bounce rate", () => {
    const verdict = detectAutobounce({
      status: "PAUSED",
      campaign: { name: "Vasco - Signal - Warranty Admin Hiring" },
      settings: { bounce_auto_pause_threshold: 5 },
      analytics: { sent_count: 200, bounce_count: 16, bounce_rate: 8 },
      fallbackThreshold: 5,
      minSample: 20,
    });
    assert.equal(verdict.paused, true);
    assert.equal(verdict.autobounce, true);
    assert.match(verdict.reason, /8\.0%|autobounce threshold/i);
  });

  it("detects an explicit autobounce pause reason", () => {
    const verdict = detectAutobounce({
      status: "PAUSED",
      campaign: { pause_reason: "auto_bounce_threshold_reached" },
      analytics: { sent_count: 5, bounce_count: 1 },
      fallbackThreshold: 5,
      minSample: 20,
    });
    assert.equal(verdict.autobounce, true);
  });

  it("does not treat a manual pause with low bounce as autobounce", () => {
    const verdict = detectAutobounce({
      status: "PAUSED",
      campaign: { name: "SalesGlider Nurture" },
      analytics: { sent_count: 400, bounce_count: 4, bounce_rate: 1 },
      fallbackThreshold: 5,
      minSample: 20,
    });
    assert.equal(verdict.autobounce, false);
  });

  it("ignores active campaigns even with high bounce", () => {
    const verdict = detectAutobounce({
      status: "ACTIVE",
      analytics: { sent_count: 200, bounce_count: 20, bounce_rate: 10 },
      fallbackThreshold: 5,
      minSample: 20,
    });
    assert.equal(verdict.autobounce, false);
  });
});
