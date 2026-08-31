import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseSending } from "./sending.js";
import type { CampaignSchedule } from "./schedule.js";

const weekdayWindow: CampaignSchedule = {
  timeZone: "America/New_York",
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  startMinute: 0,
  endHour: 17,
  endMinute: 0,
  gapMinutes: 10,
  maxLeadsPerDay: null,
};

describe("sending diagnosis", () => {
  it("does not alert Parlay when today's scheduled cap is all that went out", () => {
    const result = diagnoseSending({
      sent: 15,
      remaining: 420,
      schedule: { ...weekdayWindow, maxLeadsPerDay: 15 },
      inboxes: { attached: 40, staffable: 38, disconnected: 2, inboxesThatSent: 12 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, false);
    assert.equal(result.kind, "ok_scheduled");
    assert.match(result.reason, /scheduled today/i);
  });

  it("does not alert when the campaign only had 15 leads left", () => {
    const result = diagnoseSending({
      sent: 15,
      remaining: 15,
      schedule: weekdayWindow,
      inboxes: { attached: 20, staffable: 20, disconnected: 0, inboxesThatSent: 8 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, false);
    assert.match(result.reason, /left to send/i);
  });

  it("alerts TechEvo-style one send on a thin staff", () => {
    const result = diagnoseSending({
      sent: 1,
      remaining: 842,
      schedule: weekdayWindow,
      inboxes: { attached: 1, staffable: 1, disconnected: 0, inboxesThatSent: 1 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, true);
    assert.equal(result.kind, "not_staffed");
    assert.match(result.reason, /1 staffable inbox/i);
    assert.ok(result.receipts.some((line) => /10 min gap/i.test(line)));
  });

  it("alerts when many inboxes are attached but SMTP is down", () => {
    const result = diagnoseSending({
      sent: 2,
      remaining: 500,
      schedule: weekdayWindow,
      inboxes: { attached: 20, staffable: 2, disconnected: 18, inboxesThatSent: 1 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, true);
    assert.equal(result.kind, "inboxes_down");
  });

  it("treats a 10-minute gap ceiling as fine, not a shortfall", () => {
    const shortWindow: CampaignSchedule = {
      ...weekdayWindow,
      startHour: 16,
      endHour: 17,
    };
    const result = diagnoseSending({
      sent: 6,
      remaining: 400,
      schedule: shortWindow,
      inboxes: { attached: 1, staffable: 1, disconnected: 0, inboxesThatSent: 1 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, false);
    assert.equal(result.kind, "ok_gap_limited");
  });

  it("does not alert Parlay-style drips just because inboxes could send more", () => {
    const result = diagnoseSending({
      sent: 14,
      remaining: 338,
      schedule: weekdayWindow,
      inboxes: { attached: 18, staffable: 18, disconnected: 0, inboxesThatSent: 10 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, false);
  });

  it("alerts when a staffed campaign sent nothing with leads still in play", () => {
    const result = diagnoseSending({
      sent: 0,
      remaining: 79,
      schedule: weekdayWindow,
      inboxes: { attached: 74, staffable: 73, disconnected: 1, inboxesThatSent: 0 },
      messagePerDay: 30,
    });
    assert.ok(result);
    assert.equal(result.shouldAlert, true);
    assert.equal(result.kind, "under_sending");
  });

  it("does not invent a miss when remaining is unknown", () => {
    assert.equal(
      diagnoseSending({
        sent: 0,
        remaining: null,
        schedule: weekdayWindow,
        inboxes: { attached: 10, staffable: 10, disconnected: 0, inboxesThatSent: 0 },
        messagePerDay: 30,
      }),
      null,
    );
  });
});
