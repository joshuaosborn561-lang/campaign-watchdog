import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLinkedInboxCount } from "./inboxes.js";
import {
  UNDER_REASON_FALLBACK,
  explainUnderVolume,
  formatUnderFlag,
} from "./under-reason.js";

describe("explainUnderVolume", () => {
  it("picks too few leads when the hopper cannot hit the day", () => {
    assert.deepEqual(
      explainUnderVolume({ sent: 242, remaining: 80 }),
      { kind: "leads", text: "too few leads on ACTIVE lists" },
    );
    assert.deepEqual(
      explainUnderVolume({ sent: 200, remaining: 0, attached: 40 }),
      { kind: "leads", text: "no leads left on ACTIVE lists" },
    );
    assert.equal(
      explainUnderVolume({ sent: 200, remaining: 5000, attached: 40 }).kind,
      "pace",
    );
  });

  it("picks too few inboxes when linked senders are below CANON 40", () => {
    assert.deepEqual(
      explainUnderVolume({ sent: 97, remaining: 8000, attached: 20 }),
      { kind: "inboxes", text: "only ~20 campaign inboxes linked" },
    );
    assert.deepEqual(
      explainUnderVolume({ sent: 10, remaining: 8000, attached: 0 }),
      { kind: "inboxes", text: "no campaign inboxes linked" },
    );
    assert.deepEqual(
      explainUnderVolume({
        sent: 10,
        remaining: 8000,
        attached: 20,
        staffable: 2,
        disconnected: 18,
      }),
      { kind: "inboxes", text: "18 senders disconnected (SMTP/IMAP down)" },
    );
  });

  it("never blames a high bounce rate alone — only an actual auto-pause", () => {
    assert.deepEqual(
      explainUnderVolume({ sent: 200, remaining: 8000, attached: 40, bounced: 16 }),
      { kind: "pace", text: "pace short of 1,200" },
    );
    assert.deepEqual(
      explainUnderVolume({ sent: 200, remaining: 8000, attached: 40, bounceHold: true }),
      { kind: "bounce", text: "bounce hold: a list was auto-paused for high bounce" },
    );
  });

  it("sender-capped when >=90% of senders hit their limit, even with high bounce", () => {
    // 10/21-style: 67 senders, 66 at cap, 684/day max, 2.9% bounce.
    assert.deepEqual(
      explainUnderVolume({
        sent: 683, bounced: 20, remaining: 849, attached: 67,
        sendersTotal: 67, sendersAtCap: 66, senderDailyMax: 684, capacityLeft: 1,
      }),
      { kind: "senders", text: "sender-capped: 66 of 67 senders hit their daily limit (684/day max)" },
    );
    // All at cap, 18% bounce, under 40 seats → still the sender cap.
    assert.equal(
      explainUnderVolume({
        sent: 555, bounced: 100, remaining: 4428, attached: 27,
        sendersTotal: 27, sendersAtCap: 27, senderDailyMax: 555, capacityLeft: 0,
      }).text,
      "sender-capped: all 27 senders hit their daily limit (555/day max)",
    );
  });

  it("not enough leads when new leads left < remaining sender capacity", () => {
    // 75 senders, 15 at cap, ~1,074 capacity left, 293 new leads, high bounce.
    assert.deepEqual(
      explainUnderVolume({
        sent: 693, bounced: 60, remaining: 293, attached: 75,
        sendersTotal: 75, sendersAtCap: 15, senderDailyMax: 1767, capacityLeft: 1074,
      }),
      {
        kind: "leads",
        text: "not enough leads: 293 new leads left vs 1,074 sends of capacity left",
      },
    );
    assert.equal(
      explainUnderVolume({
        sent: 0, remaining: 0, attached: 50,
        sendersTotal: 50, sendersAtCap: 0, senderDailyMax: 1000, capacityLeft: 1000,
      }).kind,
      "leads",
    );
  });

  it("flags disconnected senders after paused checks", () => {
    assert.equal(
      explainUnderVolume({
        sent: 400, remaining: 9000, attached: 45, staffable: 43,
        sendersTotal: 45, sendersAtCap: 10, senderDailyMax: 900, capacityLeft: 500,
      }).text,
      "2 senders disconnected (SMTP/IMAP down)",
    );
  });

  it("picks paused campaigns when most lists are paused", () => {
    assert.deepEqual(
      explainUnderVolume({
        sent: 80,
        remaining: 8000,
        attached: 40,
        pausedCampaigns: 3,
        activeCampaigns: 1,
      }),
      { kind: "paused", text: "3 campaigns paused" },
    );
    assert.deepEqual(
      explainUnderVolume({
        sent: 80,
        remaining: 8000,
        attached: 40,
        pausedCampaigns: 1,
        activeCampaigns: 1,
      }),
      { kind: "paused", text: "paused campaigns" },
    );
    assert.equal(
      explainUnderVolume({
        sent: 80,
        remaining: 8000,
        attached: 40,
        pausedCampaigns: 1,
        activeCampaigns: 4,
      }).kind,
      "pace",
    );
  });

  it("picks daily cap when the Smartlead cap cannot reach 1,080", () => {
    assert.deepEqual(
      explainUnderVolume({
        sent: 180,
        remaining: 8000,
        attached: 40,
        maxLeadsPerDay: 200,
      }),
      { kind: "caps", text: "daily send cap hitting" },
    );
  });

  it("picks outside send window only when that flag is true", () => {
    assert.deepEqual(
      explainUnderVolume({
        sent: 80,
        remaining: 8000,
        attached: 40,
        outsideWindow: true,
      }),
      { kind: "schedule", text: "outside send window" },
    );
    assert.equal(
      explainUnderVolume({
        sent: 80,
        remaining: 8000,
        attached: 40,
        outsideWindow: false,
      }).text,
      UNDER_REASON_FALLBACK,
    );
  });

  it("reads linked inbox counts from campaign detail without an accounts sweep", () => {
    assert.equal(parseLinkedInboxCount({ email_account_ids: [1, 2, 3] }), 3);
    assert.equal(
      parseLinkedInboxCount({ email_accounts: [{ id: 1 }, { id: 2 }] }),
      2,
    );
    assert.equal(parseLinkedInboxCount({ email_account_count: 20 }), 20);
    assert.equal(parseLinkedInboxCount({ name: "Vasco - Signal" }), null);
  });

  it("falls back to a terse pace phrase", () => {
    assert.deepEqual(explainUnderVolume({ sent: 80 }), {
      kind: "pace",
      text: UNDER_REASON_FALLBACK,
    });
    assert.equal(formatUnderFlag(false), "");
    assert.equal(formatUnderFlag(true), ` · *under* — ${UNDER_REASON_FALLBACK}`);
    assert.equal(
      formatUnderFlag(true, "too few leads on ACTIVE lists"),
      " · *under* — too few leads on ACTIVE lists",
    );
  });
});
