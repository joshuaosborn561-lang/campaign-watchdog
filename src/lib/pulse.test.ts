import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatClientPulse,
  isPulseWindow,
  parseTodayVolume,
  pulseSlot,
  resolvePulseSlot,
  rollupClientPulse,
  stillPausedCampaigns,
} from "./pulse.js";

describe("client pulse", () => {
  it("rolls sent and bounces up by client", () => {
    const rows = rollupClientPulse([
      { clientId: 1, clientName: "Goliath Cybersecurity", sent: 80, bounced: 1 },
      { clientId: 1, clientName: "Goliath Cybersecurity", sent: 13, bounced: 0 },
      { clientId: 2, clientName: "TechEvolution", sent: 6, bounced: 1 },
      { clientId: 3, clientName: "SalesGlider", sent: 0, bounced: 0 },
    ]);
    assert.equal(rows[0].clientName, "Goliath Cybersecurity");
    assert.equal(rows[0].sent, 93);
    assert.equal(rows[0].bounced, 1);
    assert.equal(rows[2].clientName, "SalesGlider");
  });

  it("does not bleed another client's day volume into BCP when names collide", () => {
    const rows = rollupClientPulse([
      { clientId: 999001, clientName: "Bolder Cyber Partners", sent: 5328, bounced: 0 },
      { clientId: 542838, clientName: "Bolder Cyber Partners", sent: 0, bounced: 0 },
      { clientId: null, clientName: "Unknown client", sent: 400, bounced: 0 },
    ]);
    const bcp = rows.find((row) => row.clientId === 542838);
    const other = rows.find((row) => row.clientId === 999001);
    const untagged = rows.find((row) => row.clientId == null);
    assert.equal(bcp?.sent, 0);
    assert.equal(other?.sent, 5328);
    assert.equal(untagged?.sent, 400);
  });

  it("writes a short per-client Slack pulse", () => {
    const text = formatClientPulse({
      day: "2026-08-27",
      hour: 14,
      bounceWarn: 5,
      clients: [
        { clientName: "Goliath Cybersecurity", sent: 93, bounced: 1 },
        { clientName: "TechEvolution", sent: 12, bounced: 1 },
        { clientName: "SalesGlider", sent: 40, bounced: 4 },
        { clientName: "Culture Fits", sent: 0, bounced: 0 },
      ],
    });
    assert.match(text, /Thu 8\/27 2:00pm — sent today/);
    assert.match(text, /\*Goliath Cybersecurity\* — 93 sent · 1\.1% bounce/);
    assert.match(text, /\*SalesGlider\* — 40 sent · \*10\.0% bounce\*/);
    assert.match(text, /\*Culture Fits\* — 0 sent/);
    assert.match(text, /Total 145 sent · 4\.1% bounce/);
    assert.doesNotMatch(text, /Paused/);
  });

  it("names every paused campaign on the 2-hour pulse", () => {
    const text = formatClientPulse({
      day: "2026-08-27",
      hour: 10,
      bounceWarn: 5,
      clients: [{ clientName: "Bolder Cyber Partners", sent: 0, bounced: 0 }],
      paused: [
        {
          clientName: "Bolder Cyber Partners",
          campaignName: "BCP Healthcare Under-1k (With Team)",
        },
        {
          clientName: "Bolder Cyber Partners",
          campaignName: "BCP Generic (No Team)",
        },
        {
          clientName: "Vasco Warranty",
          campaignName: "Vasco - Signal - Warranty Admin Hiring",
        },
        {
          clientName: "Bolder Cyber Partners",
          campaignName: "Canary shell: #3763797 BCP Generic (With Team)",
        },
      ],
    });
    assert.match(text, /Thu 8\/27 10:00am — sent today/);
    assert.match(text, /\*Paused\* \(3\)/);
    assert.match(text, /• \*Bolder Cyber Partners\* — Generic \(No Team\)/);
    assert.match(text, /• \*Bolder Cyber Partners\* — Healthcare Under-1k \(With Team\)/);
    assert.match(text, /• \*Vasco Warranty\* — Signal - Warranty Admin Hiring/);
    assert.doesNotMatch(text, /Canary/i);
  });

  it("keeps every still-paused campaign, including Generic and other clients", () => {
    const paused = stillPausedCampaigns([
      { name: "BCP Generic (With Team)", status: "PAUSED" },
      { name: "BCP Generic (No Team)", status: "PAUSED" },
      { name: "BCP Healthcare Under-1k (With Team)", status: "ACTIVE" },
      { name: "Goliath L1 Financial Services Tickets", status: "PAUSED" },
      { name: "SalesGlider Nurture", status: "PAUSED" },
      { name: "Nieto Law Firms", status: "PAUSED" },
      { name: "Canary shell: #3763797 BCP Generic (With Team)", status: "PAUSED" },
      { name: "Pod control shell", status: "PAUSED" },
    ]);
    assert.deepEqual(
      paused.map((row) => row.name),
      [
        "BCP Generic (With Team)",
        "BCP Generic (No Team)",
        "Goliath L1 Financial Services Tickets",
        "SalesGlider Nurture",
        "Nieto Law Firms",
      ],
    );
  });

  it("reads today's sent and bounce from analytics-by-date", () => {
    assert.deepEqual(
      parseTodayVolume({ sent_count: "32", bounce_count: "2" }, "2026-09-01"),
      { sent: 32, bounced: 2 },
    );
  });

  it("keeps a true 0-send day instead of using lifetime sent_count", () => {
    assert.deepEqual(
      parseTodayVolume(
        {
          sent_count: 5328,
          bounce_count: 12,
          data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }],
        },
        "2026-09-01",
      ),
      { sent: 0, bounced: 0 },
    );
    assert.deepEqual(
      parseTodayVolume(
        {
          sent_count: 620,
          days: [
            { date: "2026-08-31", sent_count: 620, bounce_count: 1 },
            { date: "2026-09-01", sent_count: 0, bounce_count: 0 },
          ],
        },
        "2026-09-01",
      ),
      { sent: 0, bounced: 0 },
    );
  });

  it("does not sum other days when the requested Chicago day has no row", () => {
    assert.deepEqual(
      parseTodayVolume(
        {
          sent_count: 5294,
          data: [{ date: "2026-08-31", sent_count: 5294, bounce_count: 3 }],
        },
        "2026-09-01",
      ),
      { sent: 0, bounced: 0 },
    );
    assert.deepEqual(parseTodayVolume({ data: [] }, "2026-09-01"), { sent: 0, bounced: 0 });
  });

  it("only fires 8am–4pm ET Monday–Thursday, not the 5pm wrap-up hour", () => {
    const hours = [8, 10, 12, 14, 16];
    const days = [1, 2, 3, 4];
    // Thu 8/27 2:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-27T18:00:00.000Z"), "America/New_York", hours, days),
      true,
    );
    // Thu 8/27 4:00pm ET — last pulse
    assert.equal(
      isPulseWindow(new Date("2026-08-27T20:00:00.000Z"), "America/New_York", hours, days),
      true,
    );
    // Thu 8/27 5:00pm ET — digest hour, no pulse
    assert.equal(
      isPulseWindow(new Date("2026-08-27T21:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    // Thu 8/27 3:00pm ET — not a scheduled slot
    assert.equal(
      isPulseWindow(new Date("2026-08-27T19:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    // Thu 8/27 6:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-27T22:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    // Fri 8/28 2:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-28T18:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    // Sat 8/22 2:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-22T18:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    // Thu 8/27 7:00am ET
    assert.equal(
      isPulseWindow(new Date("2026-08-27T11:00:00.000Z"), "America/New_York", hours, days),
      false,
    );
    assert.equal(pulseSlot("2026-08-27", 14), "2026-08-27T14");
  });

  it("still posts a queued pulse after the hour when the watch ran long", () => {
    const hours = [8, 10, 12, 14, 16];
    const days = [1, 2, 3, 4];
    const zone = "America/Chicago";
    // Tue 9/1 10:05am CT — on the slot
    assert.deepEqual(
      resolvePulseSlot(new Date("2026-09-01T15:05:00.000Z"), zone, hours, days)?.slot,
      "2026-09-01T10",
    );
    // Tue 9/1 10:40am CT — queued behind the 15-minute watch
    assert.deepEqual(
      resolvePulseSlot(new Date("2026-09-01T15:40:00.000Z"), zone, hours, days)?.slot,
      "2026-09-01T10",
    );
    // Tue 9/1 11:50am CT — still the 10am slot (grace), not silent
    assert.deepEqual(
      resolvePulseSlot(new Date("2026-09-01T16:50:00.000Z"), zone, hours, days)?.slot,
      "2026-09-01T10",
    );
    // Tue 9/1 12:05pm CT — next slot
    assert.deepEqual(
      resolvePulseSlot(new Date("2026-09-01T17:05:00.000Z"), zone, hours, days)?.slot,
      "2026-09-01T12",
    );
    // Tue 9/1 5:10pm CT — delayed 4pm pulse may still post; cron does not fire at 5
    assert.deepEqual(
      resolvePulseSlot(new Date("2026-09-01T22:10:00.000Z"), zone, hours, days)?.slot,
      "2026-09-01T16",
    );
    // Tue 9/1 6:00pm CT — past grace, digest-only
    assert.equal(
      resolvePulseSlot(new Date("2026-09-01T23:00:00.000Z"), zone, hours, days),
      null,
    );
  });
});
