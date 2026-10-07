import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BOUNCE_RESUME_EXCLUDE_IDS,
  GOLIATH_BOUNCE_RESUME_CLIENT_ID,
  GOLIATH_BOUNCE_RESUME_HOLD_THROUGH,
  bounceResumeSkipReason,
  isBounceHold,
  isBounceProtectionReason,
  pausedReasonFrom,
  selectBounceHoldsToResume,
  type BounceResumeCandidate,
  type BounceResumeRules,
} from "./bounce-resume.js";

const chicago = "America/Chicago";
const beforeHold = new Date("2026-10-07T15:05:00.000Z");
const afterHold = new Date("2026-10-16T15:05:00.000Z");

function rules(partial: Partial<BounceResumeRules> = {}): BounceResumeRules {
  return {
    enabled: true,
    excludeIds: DEFAULT_BOUNCE_RESUME_EXCLUDE_IDS,
    now: beforeHold,
    timeZone: chicago,
    ...partial,
  };
}

function hold(partial: Partial<BounceResumeCandidate> & Pick<BounceResumeCandidate, "id">): BounceResumeCandidate {
  return {
    name: "BCP Healthcare Under-1k (No Team)",
    status: "PAUSED",
    clientId: 542838,
    pausedReason: "bounce protection",
    linkedMailboxes: 40,
    remainingLeads: 800,
    ...partial,
  };
}

describe("bounce-resume selection", () => {
  it("treats bounce protection copy and Watchdog stamps as holds", () => {
    assert.equal(isBounceProtectionReason("bounce protection"), true);
    assert.equal(isBounceProtectionReason("High Bounce Rate Auto Protection"), true);
    assert.equal(isBounceProtectionReason("manual review"), false);
    assert.equal(isBounceHold(hold({ id: 1, lastAutobounceAlertAt: "2026-10-07T12:00:00.000Z" })), true);
    assert.equal(isBounceHold(hold({ id: 2, pausedReason: null, fromActivityLog: true })), true);
    assert.equal(isBounceHold(hold({ id: 3, pausedReason: "operator pause", lastAutobounceAlertAt: undefined })), false);
  });

  it("reads paused_reason from campaign_activity_logs", () => {
    assert.equal(
      pausedReasonFrom({
        campaign_activity_logs: [
          { paused_reason: "manual" },
          { paused_reason: "bounce protection" },
        ],
      }),
      "bounce protection",
    );
    assert.equal(pausedReasonFrom({ paused_reason: "bounce protection" }), "bounce protection");
  });

  it("starts a bounce hold that has a client, mailboxes, and leads", () => {
    assert.equal(bounceResumeSkipReason(hold({ id: 99 }), rules()), null);
    assert.deepEqual(
      selectBounceHoldsToResume([hold({ id: 99 })], rules()).map((row) => row.id),
      [99],
    );
  });

  it("skips exclude-list IDs, Goliath through the hold date, empty lists, and no-client shells", () => {
    const excluded = DEFAULT_BOUNCE_RESUME_EXCLUDE_IDS[0];
    assert.equal(bounceResumeSkipReason(hold({ id: excluded }), rules()), "excluded id");
    assert.equal(
      bounceResumeSkipReason(
        hold({ id: 10, clientId: GOLIATH_BOUNCE_RESUME_CLIENT_ID, name: "Goliath Displacement" }),
        rules(),
      ),
      "goliath hold",
    );
    assert.equal(
      bounceResumeSkipReason(
        hold({ id: 10, clientId: GOLIATH_BOUNCE_RESUME_CLIENT_ID, name: "Goliath Displacement" }),
        rules({ now: afterHold }),
      ),
      null,
    );
    assert.equal(GOLIATH_BOUNCE_RESUME_HOLD_THROUGH, "2026-10-15");
    assert.equal(bounceResumeSkipReason(hold({ id: 11, linkedMailboxes: 0 }), rules()), "no mailboxes");
    assert.equal(bounceResumeSkipReason(hold({ id: 12, remainingLeads: 0 }), rules()), "no leads");
    assert.equal(bounceResumeSkipReason(hold({ id: 13, clientId: null, name: "Canary leftover" }), rules()), "no client");
    assert.equal(
      bounceResumeSkipReason(hold({ id: 14, name: "Canary shell: #1 probe", clientId: 542838 }), rules()),
      "noise",
    );
    assert.equal(
      bounceResumeSkipReason(hold({ id: 15, pausedReason: "operator", lastAutobounceAlertAt: undefined }), rules()),
      "not a bounce hold",
    );
  });

  it("honors the AUTO_RESUME_BOUNCE_HOLDS kill switch", () => {
    assert.equal(bounceResumeSkipReason(hold({ id: 99 }), rules({ enabled: false })), "disabled");
    assert.deepEqual(selectBounceHoldsToResume([hold({ id: 99 })], rules({ enabled: false })), []);
  });
});
