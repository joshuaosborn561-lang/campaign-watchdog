import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachPulseUnder,
  classifyPulseOffTrack,
  classifyPulseShortfall,
  DEFAULT_SLACK_CAYDEN_USER_ID,
  DEFAULT_SLACK_JOSH_USER_ID,
  formatClientPulse,
  formatUnderMentionLine,
  isPulseExcludedCampaign,
  isPulseWindow,
  parseTodayVolume,
  pausedSeenOnDay,
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
    assert.doesNotMatch(text, /<@/);
    assert.doesNotMatch(text, /\*under\*/);
  });

  it("flags *under* and mentions Cayden + Josh only when a client is under", () => {
    const mentions = [DEFAULT_SLACK_CAYDEN_USER_ID, DEFAULT_SLACK_JOSH_USER_ID];
    const clean = formatClientPulse({
      day: "2026-09-01",
      hour: 10,
      bounceWarn: 5,
      mentionUserIds: mentions,
      clients: [
        { clientName: "Bolder Cyber Partners", sent: 400, bounced: 2 },
        { clientName: "Vasco Warranty", sent: 200, bounced: 0 },
      ],
    });
    assert.match(clean, /Tue 9\/1 10:00am — sent today/);
    assert.doesNotMatch(clean, /<@/);
    assert.doesNotMatch(clean, /\*under\*/);

    const under = formatClientPulse({
      day: "2026-09-01",
      hour: 10,
      bounceWarn: 5,
      mentionUserIds: mentions,
      clients: [
        { clientName: "Bolder Cyber Partners", sent: 400, bounced: 2 },
        { clientName: "Vasco Warranty", sent: 80, bounced: 0, under: true },
      ],
    });
    assert.equal(
      under.split("\n")[0],
      `<@${DEFAULT_SLACK_CAYDEN_USER_ID}> <@${DEFAULT_SLACK_JOSH_USER_ID}>`,
    );
    assert.match(under, /\*Vasco Warranty\* — 80 sent · 0\.0% bounce · \*under\*/);
    assert.match(under, /\*Bolder Cyber Partners\* — 400 sent · 0\.5% bounce$/m);
    assert.doesNotMatch(under, /too few leads/);
    assert.doesNotMatch(under, /Off track/);
    assert.doesNotMatch(under, /Refill soon/);
  });

  it("does not @ anyone for under when mention ids are missing", () => {
    const text = formatClientPulse({
      day: "2026-09-01",
      hour: 10,
      bounceWarn: 5,
      clients: [{ clientName: "Vasco Warranty", sent: 0, bounced: 0, under: true }],
    });
    assert.match(text, /\*Vasco Warranty\* — 0 sent · \*under\*/);
    assert.doesNotMatch(text, /<@/);
  });

  it("copies volume *under* onto the matching client pulse row", () => {
    const clients = attachPulseUnder(
      [
        { clientId: 542838, clientName: "Bolder Cyber Partners", sent: 400, bounced: 0 },
        { clientId: 548609, clientName: "Vasco Warranty", sent: 80, bounced: 0 },
      ],
      [
        { clientId: 542838, clientName: "Bolder Cyber Partners", under: false },
        { clientId: 548609, clientName: "Vasco Warranty", under: true },
      ],
    );
    assert.equal(clients[0].under, false);
    assert.equal(clients[1].under, true);
    assert.equal(
      formatUnderMentionLine([DEFAULT_SLACK_CAYDEN_USER_ID, DEFAULT_SLACK_JOSH_USER_ID]),
      `<@${DEFAULT_SLACK_CAYDEN_USER_ID}> <@${DEFAULT_SLACK_JOSH_USER_ID}>`,
    );
  });

  it("counts paused campaigns without naming them", () => {
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
    assert.match(text, /\*Bolder Cyber Partners\* — 0 sent$/m);
    assert.match(text, /Paused: 3 \(new pauses still alert via 15m watch\)/);
    assert.doesNotMatch(text, /\*Paused\*/);
    assert.doesNotMatch(text, /• /);
    assert.doesNotMatch(text, /Generic \(No Team\)/);
    assert.doesNotMatch(text, /Healthcare Under-1k/);
    assert.doesNotMatch(text, /Warranty Admin Hiring/);
    assert.doesNotMatch(text, /Canary/i);
  });

  it("lists only pauses newly seen this Chicago day", () => {
    const paused = [
      {
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Healthcare Under-1k (With Team)",
        campaignId: 3763799,
      },
      {
        clientName: "Vasco Warranty",
        campaignName: "Vasco - Signal - Warranty Admin Hiring",
        campaignId: 50,
      },
    ];
    const today = pausedSeenOnDay(
      paused,
      new Map([[3763799, "2026-08-27T15:10:00.000Z"]]),
      "2026-08-27",
      "America/Chicago",
    );
    assert.deepEqual(
      today.map((row) => row.campaignId),
      [3763799],
    );
    const text = formatClientPulse({
      day: "2026-08-27",
      hour: 10,
      bounceWarn: 5,
      clients: [{ clientName: "Bolder Cyber Partners", sent: 12, bounced: 0 }],
      paused,
      pausedToday: today,
    });
    assert.match(text, /Paused: 2 \(new pauses still alert via 15m watch\)/);
    assert.match(text, /• \*Bolder Cyber Partners\* — Healthcare Under-1k \(With Team\) `#3763799` \(today\)/);
    assert.doesNotMatch(text, /Warranty Admin Hiring/);
  });

  it("formats Off track lines with client, campaign, id, and reason", () => {
    const text = formatClientPulse({
      day: "2026-08-27",
      hour: 10,
      bounceWarn: 5,
      clients: [
        { clientName: "SalesGlider", sent: 11, bounced: 0 },
        { clientName: "Goliath Cybersecurity", sent: 0, bounced: 0 },
      ],
      offTrack: [
        {
          clientName: "SalesGlider",
          campaignName: "SalesGlider Nurture",
          campaignId: 3122546,
          reason: "too few leads (notStarted=0, remaining=12)",
        },
        {
          clientName: "Goliath Cybersecurity",
          campaignName: "Goliath L4 Education Tickets",
          campaignId: 456,
          reason: "too few senders (8/10 vs CANON min-40)",
        },
        {
          clientName: "Parlay Tech",
          campaignName: "Parlay Sports",
          campaignId: 789,
          reason: "18 of 20 attached SMTP/IMAP down",
        },
        {
          clientName: "Bolder Cyber Partners",
          campaignName: "Canary shell: #1 BCP Generic (With Team)",
          campaignId: 1,
          reason: "too few senders (0/0 vs CANON min-40)",
        },
      ],
    });
    assert.match(text, /\*SalesGlider\* — 11 sent · 0\.0% bounce/);
    assert.doesNotMatch(text, /11 sent · too few/);
    assert.match(text, /\*Off track\*/);
    assert.match(
      text,
      /• \*SalesGlider\* — Nurture `#3122546` — too few leads \(notStarted=0, remaining=12\)/,
    );
    assert.match(
      text,
      /• \*Goliath Cybersecurity\* — L4 Education Tickets `#456` — too few senders \(8\/10 vs CANON min-40\)/,
    );
    assert.match(text, /• \*Parlay Tech\* — Sports `#789` — 18 of 20 attached SMTP\/IMAP down/);
    assert.doesNotMatch(text, /Canary/i);
  });

  it("classifies 0-send off-track as senders vs leads vs SMTP", () => {
    assert.equal(classifyPulseShortfall({ remaining: 0, staffable: 8 }), "too few leads");
    assert.equal(classifyPulseShortfall({ remaining: 4, staffable: 12 }), "too few leads");
    assert.equal(classifyPulseShortfall({ remaining: 400, staffable: 1 }), "too few senders");
    assert.equal(classifyPulseShortfall({ remaining: 400, staffable: 0 }), "too few senders");
    assert.equal(
      classifyPulseShortfall({ remaining: 400, staffable: 8, attached: 10 }),
      "too few senders",
    );
    assert.equal(
      classifyPulseShortfall({
        remaining: 400,
        notStarted: 200,
        staffable: 45,
        attached: 45,
      }),
      "not_sending",
    );
    assert.equal(
      classifyPulseOffTrack({
        sent: 0,
        remaining: 12,
        notStarted: 0,
        staffable: 46,
        attached: 46,
      })?.reason,
      "too few leads (notStarted=0, remaining=12)",
    );
    assert.equal(
      classifyPulseOffTrack({
        sent: 0,
        remaining: 400,
        notStarted: 200,
        staffable: 8,
        attached: 10,
      })?.reason,
      "too few senders (8/10 vs CANON min-40)",
    );
    assert.equal(
      classifyPulseOffTrack({
        sent: 0,
        remaining: 400,
        notStarted: 200,
        staffable: 2,
        attached: 20,
        disconnected: 18,
      })?.reason,
      "18 of 20 attached SMTP/IMAP down",
    );
    assert.equal(
      classifyPulseOffTrack({
        sent: 80,
        remaining: 400,
        notStarted: 0,
        staffable: 8,
        attached: 10,
      }),
      null,
    );
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
      ],
    );
  });

  it("excludes legacy Unknown-client leftovers by name (case-insensitive, including the MSRS typo)", () => {
    const paused = stillPausedCampaigns([
      { id: 1, name: "msrs ticket offer propert manager", status: "PAUSED" },
      { id: 2, name: "MSRS2 Ticket Offer Property Manager", status: "PAUSED" },
      { id: 3, name: "Nieto Law Firms", status: "PAUSED" },
      { id: 4, name: "positive", status: "PAUSED" },
      { id: 5, name: "BCP Generic (With Team)", status: "PAUSED" },
      { id: 6, name: "SalesGlider Nurture", status: "PAUSED" },
    ]);
    assert.deepEqual(
      paused.map((row) => row.name),
      ["BCP Generic (With Team)", "SalesGlider Nurture"],
    );
    assert.equal(isPulseExcludedCampaign({ name: "MSRS Ticket Offer Propert Manager" }), true);
    assert.equal(isPulseExcludedCampaign({ name: "msrs ticket offer propert manager" }), true);
    assert.equal(isPulseExcludedCampaign({ name: "SalesGlider Nurture" }), false);
  });

  it("excludes legacy leftovers by id even when the name is missing or renamed", () => {
    assert.equal(isPulseExcludedCampaign({ id: 3437329, name: "Renamed sports offer" }), true);
    assert.equal(isPulseExcludedCampaign({ id: 3628943, name: "" }), true);
    const paused = stillPausedCampaigns([
      { id: 3867914, name: "Nieto RB2B (copy)", status: "PAUSED" },
      { id: 999999, name: "Culture Fits Sports Offer", status: "PAUSED" },
    ]);
    assert.deepEqual(
      paused.map((row) => row.name),
      ["Culture Fits Sports Offer"],
    );
  });

  it("does not create an Unknown client sent rollup from excluded leftovers only", () => {
    const rows = [
      { clientId: null, clientName: "Unknown client", sent: 0, bounced: 0 },
      { clientId: null, clientName: "Unknown client", sent: 0, bounced: 0 },
      { clientId: 542838, clientName: "Bolder Cyber Partners", sent: 12, bounced: 0 },
    ];
    const campaigns = [
      { id: 3628943, name: "Positive" },
      { id: 1, name: "MSRS Ticket Offer Propert Manager" },
      { id: 100, name: "BCP Healthcare Under-1k (No Team)" },
    ];
    const kept = rows.filter((_, index) => !isPulseExcludedCampaign(campaigns[index]));
    const rolled = rollupClientPulse(kept);
    assert.equal(rolled.some((row) => row.clientName === "Unknown client"), false);
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].clientName, "Bolder Cyber Partners");
  });

  it("omits excluded leftovers from the Slack Paused count", () => {
    const text = formatClientPulse({
      day: "2026-08-27",
      hour: 10,
      bounceWarn: 5,
      clients: [{ clientName: "Bolder Cyber Partners", sent: 0, bounced: 0 }],
      paused: [
        { clientName: "Unknown client", campaignName: "Nieto Spring", campaignId: 1 },
        { clientName: "Unknown client", campaignName: "Positive", campaignId: 3628943 },
        {
          clientName: "Bolder Cyber Partners",
          campaignName: "BCP Generic (No Team)",
          campaignId: 200,
        },
      ],
    });
    assert.match(text, /Paused: 1 \(new pauses still alert via 15m watch\)/);
    assert.doesNotMatch(text, /Generic \(No Team\)/);
    assert.doesNotMatch(text, /Unknown client/);
    assert.doesNotMatch(text, /Nieto Spring/);
    assert.doesNotMatch(text, /Positive/);
    assert.doesNotMatch(text, /• /);
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

  it("only fires 8am–4pm ET Monday–Friday, not the 5pm wrap-up hour", () => {
    const hours = [8, 10, 12, 14, 16];
    const days = [1, 2, 3, 4, 5];
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
      true,
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
    const days = [1, 2, 3, 4, 5];
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
