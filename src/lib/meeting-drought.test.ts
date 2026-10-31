import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeDrought,
  decideDroughtAlerts,
  formatDroughtAlert,
  isTestBooking,
  parseSlugMap,
  type DroughtClient,
} from "./meeting-drought.js";

const NOW = new Date("2026-10-31T14:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const clients: DroughtClient[] = [
  { clientId: 1, name: "Vector", slug: "vector" },
  { clientId: 2, name: "Parlay", slug: "parlay" },
  { clientId: 3, name: "Nutter", slug: "nutter" },
];
const bookings = [
  { clientSlug: "vector", createdAt: day(2) },
  { clientSlug: "vector", createdAt: day(5) },
  { clientSlug: "parlay", createdAt: day(9) },
];

describe("computeDrought", () => {
  it("counts the trailing 7 days and the last booking", () => {
    const [vector, parlay, nutter] = computeDrought(clients, bookings, NOW, 7);
    assert.equal(vector.meetingsInWindow, 2);
    assert.equal(parlay.meetingsInWindow, 0);
    assert.equal(parlay.daysSinceLast, 9);
    assert.equal(nutter.lastBookingAt, null);
  });
  it("ignores future-dated rows", () => {
    const [vector] = computeDrought(
      clients,
      [{ clientSlug: "vector", createdAt: new Date(NOW.getTime() + 86_400_000).toISOString() }],
      NOW,
      7,
    );
    assert.equal(vector.meetingsInWindow, 0);
  });
});

describe("decideDroughtAlerts", () => {
  const opts = { minMeetings: 1, repeatDays: 7 };
  it("alerts when first under 1 a week, repeats weekly, resets on a booking", () => {
    const statuses = computeDrought(clients, bookings, NOW, 7);
    const first = decideDroughtAlerts(statuses, {}, NOW, opts);
    assert.deepEqual(first.toAlert.map((s) => s.client.name).sort(), ["Nutter", "Parlay"]);
    const next1 = decideDroughtAlerts(statuses, first.next, new Date(NOW.getTime() + 86_400_000), opts);
    assert.equal(next1.toAlert.length, 0);
    const next7 = decideDroughtAlerts(statuses, first.next, new Date(NOW.getTime() + 7 * 86_400_000), opts);
    assert.equal(next7.toAlert.length, 2);
    const recovered = decideDroughtAlerts(
      computeDrought(clients, [...bookings, { clientSlug: "parlay", createdAt: day(0) }], NOW, 7),
      first.next,
      NOW,
      opts,
    );
    assert.equal(recovered.next["2"], undefined);
  });
});

describe("helpers", () => {
  it("flags test bookings", () => {
    assert.equal(isTestBooking({ clientSlug: "zz-test" }), true);
    assert.equal(isTestBooking({ clientSlug: "vector", leadEmail: "cf-test@example.com" }), true);
    assert.equal(isTestBooking({ clientSlug: "vector", leadEmail: "sam@acme.com" }), false);
  });
  it("parses the slug map override", () => {
    assert.deepEqual(parseSlugMap("1:Vector, 2:parlay"), { 1: "vector", 2: "parlay" });
    assert.equal(parseSlugMap("")[597119], "vector");
  });
  it("formats exceptions only", () => {
    assert.equal(formatDroughtAlert({ header: "h", statuses: [], windowDays: 7, timeZone: "America/Chicago" }), null);
    const text = formatDroughtAlert({
      header: "Meeting drought",
      statuses: computeDrought(clients, bookings, NOW, 7).filter((s) => s.meetingsInWindow < 1),
      windowDays: 7,
      timeZone: "America/Chicago",
      uncoveredNames: ["Insight"],
    });
    assert.match(text!, /\*Parlay\* — 0 meetings in 7 days \(last booked Oct 22, 9d ago\)/);
    assert.match(text!, /no bookings on record/);
    assert.match(text!, /Can't check, no booking source: Insight/);
  });
});
