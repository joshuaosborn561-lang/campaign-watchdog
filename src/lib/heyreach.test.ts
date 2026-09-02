import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProgressStats } from "../clients/heyreach.js";
import {
  DEFAULT_HEYREACH_EXCLUDE_IDS,
  formatHeyReachRunwayMessage,
  heyreachAlertFlags,
  heyreachAlertKey,
  heyreachRemaining,
  isHeyReachExcluded,
  runwayDays,
  shouldAlertHeyReach,
  weekdayPaceFromStats,
} from "./heyreach.js";

describe("heyreach runway", () => {
  it("counts remaining as pending + inProgress", () => {
    assert.equal(heyreachRemaining({ pending: 305, inProgress: 122 }), 427);
    assert.equal(heyreachRemaining({ pending: 0, inProgress: 21 }), 21);
    assert.equal(heyreachRemaining({ pending: 0, inProgress: 0 }), 0);
  });

  it("reads HeyReach progressStats field names", () => {
    const stats = parseProgressStats({
      totalUsers: 45,
      totalUsersPending: 0,
      totalUsersInProgress: 21,
      totalUsersFinished: 24,
    });
    assert.deepEqual(stats, {
      total: 45,
      pending: 0,
      inProgress: 21,
      finished: 24,
      failed: 0,
    });
  });

  it("averages weekday connectionsSent + messagesSent", () => {
    const { pace, samples } = weekdayPaceFromStats({
      byDayStats: {
        "2026-08-24": { connectionsSent: 2, messagesSent: 1 }, // Mon
        "2026-08-25": { connectionsSent: 2, messagesSent: 2 }, // Tue
        "2026-08-26": { connectionsSent: 1, messagesSent: 2 }, // Wed
        "2026-08-27": { connectionsSent: 2, messagesSent: 1 }, // Thu
        "2026-08-28": { connectionsSent: 3, messagesSent: 2 }, // Fri
        "2026-08-29": { connectionsSent: 40, messagesSent: 40 }, // Sat ignored
        "2026-08-30": { connectionsSent: 40, messagesSent: 40 }, // Sun ignored
      },
    });
    assert.equal(samples, 5);
    assert.ok(pace != null);
    assert.equal(Number(pace.toFixed(1)), 3.6);
    assert.equal(Number(runwayDays(21, pace)?.toFixed(1)), 5.8);
  });

  it("flags under-7 and pending-dry on IN_PROGRESS only", () => {
    const both = heyreachAlertFlags({
      campaignId: 566902,
      status: "IN_PROGRESS",
      pending: 0,
      runwayDays: 5.8,
    });
    assert.deepEqual(both, { under7: true, pendingDry: true, excluded: false });
    assert.equal(shouldAlertHeyReach(both), true);

    const ok = heyreachAlertFlags({
      campaignId: 557698,
      status: "IN_PROGRESS",
      pending: 305,
      runwayDays: 20,
    });
    assert.deepEqual(ok, { under7: false, pendingDry: false, excluded: false });
    assert.equal(shouldAlertHeyReach(ok), false);

    const paused = heyreachAlertFlags({
      campaignId: 1,
      status: "PAUSED",
      pending: 0,
      runwayDays: 2,
    });
    assert.equal(shouldAlertHeyReach(paused), false);
  });

  it("excludes Call Followups 530529 from under-7/dry alerts", () => {
    assert.equal(isHeyReachExcluded(530529), true);
    assert.deepEqual(DEFAULT_HEYREACH_EXCLUDE_IDS, [530529]);
    const flags = heyreachAlertFlags({
      campaignId: 530529,
      status: "IN_PROGRESS",
      pending: 0,
      runwayDays: 3.5,
    });
    assert.equal(flags.excluded, true);
    assert.equal(flags.under7, false);
    assert.equal(flags.pendingDry, false);
    assert.equal(shouldAlertHeyReach(flags), false);
  });

  it("names client + campaign like Smartlead nearly-done", () => {
    assert.equal(
      formatHeyReachRunwayMessage({
        clientName: "TechEvolution",
        campaignName: "TechEvo NE IT DM v2",
        remaining: 21,
        pending: 0,
        inProgress: 21,
        runwayDays: 5.8,
        under7: true,
        pendingDry: true,
      }),
      "*TechEvolution* — *TechEvo NE IT DM v2* is nearly done (~5.8d LinkedIn runway, 21 left, 0 pending). Refill soon.",
    );
    assert.equal(
      formatHeyReachRunwayMessage({
        clientName: "SalesGlider",
        campaignName: "Staffing Owners v2",
        remaining: 80,
        pending: 40,
        inProgress: 40,
        runwayDays: 4,
        under7: true,
        pendingDry: false,
      }),
      "*SalesGlider* — *Staffing Owners v2* is nearly done (~4d LinkedIn runway, 80 left). Refill soon.",
    );
    assert.equal(
      formatHeyReachRunwayMessage({
        clientName: "SalesGlider",
        campaignName: "Owners Nurture",
        remaining: 40,
        pending: 0,
        inProgress: 40,
        runwayDays: 12,
        under7: false,
        pendingDry: true,
      }),
      "*SalesGlider* — *Owners Nurture* is pending dry (0 new starts, still IN_PROGRESS, 40 in progress). Refill soon.",
    );
  });

  it("uses stable supabase keys so a weekday board can share dedupe", () => {
    assert.equal(heyreachAlertKey("under7", 566902), "heyreach:under7:v1:566902");
    assert.equal(heyreachAlertKey("pending-dry", 530529), "heyreach:pending-dry:v1:530529");
  });
});
