import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAutobounceMessage,
  formatCompletionMessage,
  formatSendingMessage,
} from "./messages.js";

describe("messages", () => {
  it("names the client and campaign on completion", () => {
    const text = formatCompletionMessage({
      clientName: "Vasco Warranty",
      campaignName: "Vasco - Signal - Warranty Admin Hiring",
      threshold: 75,
      percent: 76.2,
      contacted: 762,
      total: 1000,
      remaining: 238,
    });
    assert.match(text, /\*Vasco Warranty\*/);
    assert.match(text, /\*Vasco - Signal - Warranty Admin Hiring\*/);
    assert.match(text, /nearly done \(75%, 238 left\)/);
    assert.match(text, /Refill soon/);
    assert.doesNotMatch(text, /76\.2% through the list/);
  });

  it("flags a finished client with nothing else sending", () => {
    const text = formatCompletionMessage({
      clientName: "Vasco Warranty",
      campaignName: "Vasco - Signal - Warranty Admin Hiring",
      threshold: 100,
      percent: 100,
      contacted: 1000,
      total: 1000,
      remaining: 0,
    });
    assert.match(text, /finished the list/);
    assert.match(text, /this client now has nothing sending — flag for a lead refill/i);
  });

  it("names the client and campaign on autobounce", () => {
    const text = formatAutobounceMessage({
      clientName: "Goliath Cybersecurity",
      campaignName: "Goliath Displacement S 50-200 CIO",
      verdict: {
        paused: true,
        autobounce: true,
        bounceRate: 8.2,
        bounceCount: 16,
        sent: 195,
        threshold: 5,
        reason: "bounce rate 8.2% hit the 5.0% autobounce threshold",
      },
    });
    assert.match(text, /\*Goliath Cybersecurity\*/);
    assert.match(text, /autobounce/i);
  });

  it("states the reason and receipts for a send miss", () => {
    const text = formatSendingMessage({
      clientName: "TechEvolution",
      campaignName: "TechEvo New England Red Sox",
      day: "2026-08-25",
      diagnosis: {
        kind: "not_staffed",
        shouldAlert: true,
        reason: "Only 1 staffable inbox and 1 send with 842 leads left.",
        receipts: [
          "Sent 1 today",
          "842 leads left in the campaign",
          "1 staffable / 1 attached",
          "10 min gap between sends → 30 sends/inbox (30/day cap)",
        ],
        sent: 1,
        remaining: 842,
        attached: 1,
        staffable: 1,
        disconnected: 0,
        inboxesThatSent: 1,
        campaignCap: null,
        gapMinutes: 10,
        perInboxGapCap: 30,
        inboxCapacity: 30,
        schedulable: 30,
      },
    });
    assert.match(text, /\*TechEvolution\* — \*TechEvo New England Red Sox\*/);
    assert.match(text, /Only 1 staffable inbox/);
    assert.match(text, /842 leads left/);
    assert.match(text, /10 min gap/);
  });
});
