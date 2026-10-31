import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyLane,
  daysLeftOf,
  decideDoubleSigAlerts,
  decideLeadAlerts,
  formatLeadsAlert,
  leadsSkipReason,
  weekdayWindow,
  DEFAULT_LEADS_SKIP_CLIENT_IDS,
  DEFAULT_LEADS_SKIP_IDS,
  DEFAULT_LEADS_SKIP_NAME_PATTERNS,
  type LeadLane,
} from "./leads-check.js";

const lane = (over: Partial<LeadLane> = {}): LeadLane => ({
  id: 1,
  name: "Vector Big Owners",
  clientId: 597119,
  clientName: "Vector",
  notStarted: 500,
  inProgress: 10,
  perDay: 400,
  daysLeft: 1.3,
  ...over,
});
const NOW = new Date("2026-10-31T14:00:00Z");

describe("classifyLane", () => {
  it("dry at zero new leads, low under the day threshold, otherwise fine", () => {
    assert.equal(classifyLane(lane({ notStarted: 0, daysLeft: 0 }), 2), "dry");
    assert.equal(classifyLane(lane({ daysLeft: 1.3 }), 2), "low");
    assert.equal(classifyLane(lane({ daysLeft: 6 }), 2), null);
    assert.equal(classifyLane(lane({ perDay: 0, daysLeft: null }), 2), null);
  });
  it("computes days left", () => {
    assert.equal(daysLeftOf(500, 400), 1.3);
    assert.equal(daysLeftOf(500, 0), null);
    assert.equal(daysLeftOf(500, null), null);
  });
});

describe("leadsSkipReason", () => {
  const rules = {
    ids: DEFAULT_LEADS_SKIP_IDS,
    clientIds: DEFAULT_LEADS_SKIP_CLIENT_IDS,
    namePatterns: DEFAULT_LEADS_SKIP_NAME_PATTERNS,
  };
  it("skips dead / excluded lanes", () => {
    assert.equal(leadsSkipReason({ id: 9, name: "BCP Logistics IT", clientId: 542838 }, rules), "skip name");
    assert.equal(leadsSkipReason({ id: 4085158, name: "Gabe", clientId: 345263 }, rules), "skip id");
    assert.equal(leadsSkipReason({ id: 9, name: "Vasco", clientId: 548609 }, rules), "skip client");
    assert.equal(leadsSkipReason({ id: 9, name: "x", clientId: null }, rules), "no client");
    assert.equal(leadsSkipReason({ id: 9, name: "Vector A", clientId: 597119 }, rules), null);
  });
});

describe("decideLeadAlerts", () => {
  it("alerts once, stays quiet inside the reminder window, reminds after it", () => {
    const flagged = [{ lane: lane(), kind: "low" as const }];
    const first = decideLeadAlerts(flagged, {}, NOW, 24);
    assert.equal(first.toAlert.length, 1);
    const soon = decideLeadAlerts(flagged, first.next, new Date(NOW.getTime() + 3_600_000), 24);
    assert.equal(soon.toAlert.length, 0);
    const later = decideLeadAlerts(flagged, first.next, new Date(NOW.getTime() + 25 * 3_600_000), 24);
    assert.equal(later.toAlert.length, 1);
  });
  it("escalates low to dry immediately and forgets recovered lanes", () => {
    const first = decideLeadAlerts([{ lane: lane(), kind: "low" }], {}, NOW, 24);
    const dry = decideLeadAlerts([{ lane: lane({ notStarted: 0 }), kind: "dry" }], first.next, NOW, 24);
    assert.equal(dry.toAlert.length, 1);
    const recovered = decideLeadAlerts([], dry.next, NOW, 24);
    assert.deepEqual(recovered.next, {});
  });
});

describe("decideDoubleSigAlerts", () => {
  const r = { id: 7, name: "SG Referral", clientName: "SalesGlider", sampled: 4, doubles: 2, lastDoubleSentAt: "2026-10-31T13:00:00Z" };
  it("alerts new doubles once, clears silently, re-alerts on recurrence", () => {
    const a = decideDoubleSigAlerts([r], {}, NOW);
    assert.equal(a.toAlert.length, 1);
    const b = decideDoubleSigAlerts([r], a.next, NOW);
    assert.equal(b.toAlert.length, 0);
    const c = decideDoubleSigAlerts([{ ...r, doubles: 0 }], b.next, NOW);
    assert.equal(c.toAlert.length, 0);
    assert.equal(c.next["7"].status, "cleared");
    const d = decideDoubleSigAlerts([r], c.next, NOW);
    assert.equal(d.toAlert.length, 1);
  });
  it("does not clear when nothing was sampled", () => {
    const a = decideDoubleSigAlerts([r], {}, NOW);
    const b = decideDoubleSigAlerts([{ ...r, sampled: 0, doubles: 0 }], a.next, NOW);
    assert.equal(b.next["7"].status, "open");
  });
});

describe("formatLeadsAlert", () => {
  it("returns null when there is nothing to say", () => {
    assert.equal(formatLeadsAlert({ header: "h", lanes: [], doubleSigs: [], lowDays: 2 }), null);
  });
  it("groups per client with counts and names", () => {
    const text = formatLeadsAlert({
      header: "Leads check",
      lanes: [
        { lane: lane({ id: 1, notStarted: 0, daysLeft: 0 }), kind: "dry" },
        { lane: lane({ id: 2, name: "Vector Small", daysLeft: 0.8 }), kind: "low" },
      ],
      doubleSigs: [],
      lowDays: 2,
    });
    assert.match(text!, /\*Vector\* — 1 out of leads/);
    assert.match(text!, /1 under 2 days \(Small 0.8d\)/);
  });
});

describe("weekdayWindow", () => {
  it("spans the last 3 weekdays, skipping weekends", () => {
    // Thu 2026-10-29 -> Tue 10/27..Thu 10/29, end Fri 10/30
    assert.deepEqual(weekdayWindow("2026-10-29", 3), { start: "2026-10-27", end: "2026-10-30", weekdays: 3 });
    // Mon 2026-10-26 -> Wed 10/21..Mon 10/26
    assert.equal(weekdayWindow("2026-10-26", 3).start, "2026-10-22");
    // Saturday 2026-10-31 -> Wed 10/28..Fri 10/30
    assert.equal(weekdayWindow("2026-10-31", 3).start, "2026-10-28");
  });
});
