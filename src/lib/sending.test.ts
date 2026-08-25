import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendingShortfall, sendingTarget, shouldCheckSending } from "./sending.js";

describe("sending", () => {
  it("scales the 30/day target by inbox count", () => {
    assert.equal(sendingTarget(10, 30), 300);
    assert.equal(sendingTarget(1, 30), 30);
    assert.equal(sendingTarget(0, 30), 0);
  });

  it("flags a campaign under 30 per inbox", () => {
    const miss = sendingShortfall({ inboxCount: 8, sent: 200, perInboxTarget: 30 });
    assert.ok(miss);
    assert.equal(miss.expected, 240);
    assert.equal(miss.shortBy, 40);
    assert.equal(
      sendingShortfall({ inboxCount: 8, sent: 240, perInboxTarget: 30 }),
      null,
    );
  });

  it("waits until the configured hour and skips weekends", () => {
    assert.equal(
      shouldCheckSending({ hour: 16, afterHour: 17, weekend: false }),
      false,
    );
    assert.equal(
      shouldCheckSending({ hour: 17, afterHour: 17, weekend: false }),
      true,
    );
    assert.equal(
      shouldCheckSending({ hour: 18, afterHour: 17, weekend: true }),
      false,
    );
  });
});
