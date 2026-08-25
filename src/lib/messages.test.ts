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
    assert.match(text, /75% completion/);
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

  it("includes inbox math on sending shortfalls", () => {
    const text = formatSendingMessage({
      clientName: "SalesGlider",
      campaignName: "SalesGlider Staffing",
      day: "2026-08-24",
      shortfall: {
        inboxCount: 10,
        expected: 300,
        sent: 180,
        shortBy: 120,
        perInboxTarget: 30,
      },
    });
    assert.match(text, /\*SalesGlider\* — \*SalesGlider Staffing\*/);
    assert.match(text, /10 inboxes × 30/);
    assert.match(text, /180 of 300/);
  });
});
