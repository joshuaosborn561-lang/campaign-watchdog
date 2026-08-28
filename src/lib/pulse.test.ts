import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatClientPulse,
  isPulseWindow,
  parseTodayVolume,
  pulseSlot,
  rollupClientPulse,
  stillPausedCampaigns,
} from "./pulse.js";

describe("client pulse", () => {
  it("rolls sent and bounces up by client", () => {
    const rows = rollupClientPulse([
      { clientName: "Goliath Cybersecurity", sent: 80, bounced: 1 },
      { clientName: "Goliath Cybersecurity", sent: 13, bounced: 0 },
      { clientName: "TechEvolution", sent: 6, bounced: 1 },
      { clientName: "SalesGlider", sent: 0, bounced: 0 },
    ]);
    assert.equal(rows[0].clientName, "Goliath Cybersecurity");
    assert.equal(rows[0].sent, 93);
    assert.equal(rows[0].bounced, 1);
    assert.equal(rows[2].clientName, "SalesGlider");
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
      parseTodayVolume({ sent_count: "32", bounce_count: "2" }),
      { sent: 32, bounced: 2 },
    );
  });

  it("only fires 8am–5pm ET Monday–Thursday", () => {
    const hours = [8, 10, 12, 14, 16, 17];
    const days = [1, 2, 3, 4];
    // Thu 8/27 2:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-27T18:00:00.000Z"), "America/New_York", hours, days),
      true,
    );
    // Thu 8/27 5:00pm ET
    assert.equal(
      isPulseWindow(new Date("2026-08-27T21:00:00.000Z"), "America/New_York", hours, days),
      true,
    );
    // Thu 8/27 6:00pm ET — after 5
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
});
