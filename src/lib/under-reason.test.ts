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
      { kind: "inboxes", text: "most campaign inboxes SMTP/IMAP down" },
    );
  });

  it("picks bounce hold when today's bounce is over the warn line", () => {
    assert.deepEqual(
      explainUnderVolume({
        sent: 200,
        remaining: 8000,
        attached: 40,
        bounced: 16,
      }),
      { kind: "bounce", text: "bounce hold (8.0%)" },
    );
    assert.deepEqual(
      explainUnderVolume({
        sent: 200,
        remaining: 8000,
        attached: 40,
        bounceHold: true,
      }),
      { kind: "bounce", text: "bounce rate / bounce hold" },
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
