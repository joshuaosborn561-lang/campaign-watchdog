import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyTodaySends,
  formatDailyDigest,
  formatFinishedMessage,
  formatNearlyDoneMessage,
  formatPauseMessage,
  rollupClients,
  shortCampaignName,
  type DigestCampaign,
} from "./digest.js";

function row(partial: Partial<DigestCampaign> & Pick<DigestCampaign, "clientName" | "campaignName">): DigestCampaign {
  return {
    sent: 0,
    bounced: 0,
    remaining: 0,
    notStarted: 0,
    inProgress: 0,
    staffable: 1,
    attached: 1,
    kind: "ok_on_pace",
    shouldAlert: false,
    status: "ACTIVE",
    ...partial,
  };
}

describe("digest", () => {
  it("shortens campaign names without dropping the useful bit", () => {
    assert.equal(
      shortCampaignName("TechEvolution", "TechEvo New England Red Sox"),
      "New England Red Sox",
    );
    assert.equal(
      shortCampaignName("Vasco Warranty", "Vasco - Service - Standard Brands"),
      "Service - Standard Brands",
    );
  });

  it("treats unstarted-lead sends as new and in-sequence sends as follow-up", () => {
    assert.deepEqual(
      classifyTodaySends({ sent: 28, notStarted: 311, inProgress: 27 }),
      { firstTouch: 28, followUp: 0 },
    );
    assert.deepEqual(
      classifyTodaySends({ sent: 80, notStarted: 0, inProgress: 393 }),
      { firstTouch: 0, followUp: 80 },
    );
  });

  it("rolls TechEvo up as a client staffing problem and still says how many sent", () => {
    const clients = rollupClients([
      row({
        clientName: "TechEvolution",
        campaignName: "TechEvo New England Red Sox",
        sent: 0,
        remaining: 254,
        inProgress: 254,
        shouldAlert: true,
        kind: "not_staffed",
      }),
      row({
        clientName: "TechEvolution",
        campaignName: "TechEvo SFL IT DM Jet Ski",
        sent: 1,
        remaining: 133,
        notStarted: 132,
        inProgress: 1,
        shouldAlert: true,
        kind: "not_staffed",
      }),
      row({
        clientName: "TechEvolution",
        campaignName: "TechEvo SFL IT DM AirPods",
        sent: 15,
        remaining: 133,
        notStarted: 118,
        inProgress: 15,
      }),
    ]);
    assert.equal(clients[0].severity, "problem");
    assert.match(clients[0].line, /\*TechEvolution\* — 16 sent/);
    assert.match(clients[0].line, /1 inbox on every campaign/);
    assert.match(clients[0].line, /New England Red Sox/);
  });

  it("names one stalled Parlay campaign and states first-touch volume", () => {
    const clients = rollupClients([
      row({
        clientName: "Parlay Tech",
        campaignName: "Parlay EOS Sales DM Choice",
        sent: 28,
        remaining: 338,
        notStarted: 311,
        inProgress: 27,
        staffable: 18,
        attached: 18,
      }),
      row({
        clientName: "Parlay Tech",
        campaignName: "Parlay Receipts Ops DM Tickets",
        sent: 12,
        remaining: 1275,
        notStarted: 1263,
        inProgress: 12,
        staffable: 18,
        attached: 18,
      }),
      row({
        clientName: "Parlay Tech",
        campaignName: "Parlay2 Sports Offer - copy",
        sent: 0,
        remaining: 1178,
        inProgress: 1178,
        staffable: 18,
        attached: 18,
        shouldAlert: true,
        kind: "under_sending",
      }),
    ]);
    const parlay = clients.find((item) => item.clientName === "Parlay Tech");
    assert.ok(parlay);
    assert.equal(parlay.severity, "problem");
    assert.match(parlay.line, /40 sent, all new/);
    assert.match(parlay.line, /\*Sports Offer - copy\*/);
    assert.match(parlay.line, /1,178 follow-ups waiting/);
  });

  it("collapses a client when several campaigns all sent nothing", () => {
    const clients = rollupClients([
      row({
        clientName: "SalesGlider",
        campaignName: "SalesGlider Staffing",
        sent: 0,
        remaining: 509,
        inProgress: 509,
        staffable: 73,
        attached: 74,
        shouldAlert: true,
        kind: "under_sending",
      }),
      row({
        clientName: "SalesGlider",
        campaignName: "SalesGlider Staffing Airpods Only",
        sent: 0,
        remaining: 79,
        inProgress: 79,
        staffable: 0,
        attached: 0,
        shouldAlert: true,
        kind: "not_staffed",
      }),
      row({
        clientName: "SalesGlider",
        campaignName: "SalesGlider Financial Advisors",
        sent: 0,
        remaining: 86,
        inProgress: 86,
        staffable: 0,
        attached: 0,
        shouldAlert: true,
        kind: "not_staffed",
      }),
    ]);
    assert.match(clients[0].line, /0 sent/);
    assert.match(clients[0].line, /3 campaigns sent 0/);
    assert.match(clients[0].line, /\*Staffing\* 509/);
  });

  it("keeps Goliath as a short volume line", () => {
    const clients = rollupClients([
      row({
        clientName: "Goliath Cybersecurity",
        campaignName: "Goliath Displacement L 501-1000 ITDir",
        sent: 80,
        remaining: 393,
        inProgress: 393,
        staffable: 91,
        attached: 91,
      }),
      row({
        clientName: "Goliath Cybersecurity",
        campaignName: "Goliath Education Receipts - Large Public",
        sent: 13,
        remaining: 66,
        inProgress: 66,
        staffable: 91,
        attached: 91,
      }),
    ]);
    assert.equal(clients[0].severity, "fine");
    assert.match(clients[0].line, /93 sent, all follow-up/);
  });

  it("opens the daily post with totals, campaign rows, bounce, and paused", () => {
    const text = formatDailyDigest("2026-08-27", [
      row({
        clientName: "Goliath Cybersecurity",
        campaignName: "Goliath Displacement L 501-1000 ITDir",
        sent: 80,
        bounced: 1,
        remaining: 393,
        inProgress: 393,
        staffable: 91,
        attached: 91,
      }),
      row({
        clientName: "Parlay Tech",
        campaignName: "Old list",
        sent: 5,
        bounced: 1,
        remaining: 0,
        staffable: 10,
        attached: 10,
      }),
      row({
        clientName: "Vasco Warranty",
        campaignName: "Vasco - Signal - Warranty Admin Hiring",
        sent: 0,
        remaining: 40,
        inProgress: 40,
        status: "PAUSED",
      }),
    ]);
    assert.match(text ?? "", /Thu 8\/27/);
    assert.match(text ?? "", /\*85 sent today\* \(0 new · 85 follow-up\) · 2\.4% bounce/);
    assert.match(text ?? "", /Paused: \*Vasco Warranty\* Signal - Warranty Admin Hiring/);
    assert.match(text ?? "", /Finished today: \*Parlay Tech\* Old list/);
    assert.match(text ?? "", /\*Goliath Cybersecurity\* — 80 sent, all follow-up · 1\.3% bounce/);
    assert.match(text ?? "", /• Displacement L 501-1000 ITDir — 80 sent, all follow-up · 1\.3% bounce/);
    assert.match(text ?? "", /• Signal - Warranty Admin Hiring — paused · 40 follow-ups waiting/);
    assert.match(text ?? "", /\*Parlay Tech\* — 5 sent, all follow-up · \*20\.0% bounce\*/);
  });

  it("lists every still-paused campaign instead of truncating", () => {
    const text = formatDailyDigest("2026-08-27", [
      row({
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Generic (With Team)",
        status: "PAUSED",
        remaining: 40000,
        notStarted: 40000,
      }),
      row({
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Generic (No Team)",
        status: "PAUSED",
        remaining: 10000,
        notStarted: 10000,
      }),
      row({
        clientName: "Goliath Cybersecurity",
        campaignName: "Goliath L1 Financial Services Tickets",
        status: "PAUSED",
        remaining: 200,
      }),
      row({
        clientName: "SalesGlider",
        campaignName: "SalesGlider Nurture",
        status: "PAUSED",
        remaining: 50,
      }),
      row({
        clientName: "Nieto",
        campaignName: "Nieto Law Firms",
        status: "PAUSED",
        remaining: 80,
      }),
      row({
        clientName: "Parlay Tech",
        campaignName: "Parlay Trendrr Sales DM SEG Tickets",
        status: "PAUSED",
        remaining: 30,
      }),
      row({
        clientName: "MSRS",
        campaignName: "MSRS Ticket Offer Propert Manager",
        status: "PAUSED",
        remaining: 12,
      }),
    ]);
    assert.match(text ?? "", /Paused: /);
    assert.match(text ?? "", /Generic \(With Team\)/);
    assert.match(text ?? "", /Generic \(No Team\)/);
    assert.match(text ?? "", /L1 Financial Services Tickets/);
    assert.match(text ?? "", /Nurture/);
    assert.match(text ?? "", /Law Firms/);
    assert.match(text ?? "", /Trendrr Sales DM SEG Tickets/);
    assert.match(text ?? "", /Ticket Offer Propert Manager/);
    assert.doesNotMatch(text ?? "", /more/);
  });

  it("omits canary shells from the digest", () => {
    const text = formatDailyDigest("2026-08-27", [
      row({
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Generic (With Team)",
        status: "PAUSED",
        remaining: 40000,
        notStarted: 40000,
      }),
      row({
        clientName: "Bolder Cyber Partners",
        campaignName: "Canary shell: #3763797 BCP Generic (With Team)",
        status: "PAUSED",
        remaining: 1,
        notStarted: 1,
      }),
      row({
        clientName: "Goliath Cybersecurity",
        campaignName: "Canary shell: #3781914 Goliath L4 Education Tickets",
        sent: 12,
        remaining: 4,
      }),
    ]);
    assert.match(text ?? "", /Paused: \*Bolder Cyber Partners\* Generic \(With Team\)/);
    assert.doesNotMatch(text ?? "", /Canary/i);
    assert.doesNotMatch(text ?? "", /12 sent/);
  });

  it("singles out a paused campaign", () => {
    const text = formatPauseMessage({
      clientName: "Goliath Cybersecurity",
      campaignName: "Goliath Displacement S 50-200 CIO",
      autobounce: true,
      bounceRate: 8.2,
      sent: 195,
      reason: "bounce",
    });
    assert.match(text, /\*Goliath Cybersecurity\* — \*Goliath Displacement S 50-200 CIO\*/);
    assert.match(text, /paused \(autobounce, 8\.2% bounce on 195 sends\)/);
    assert.match(
      formatFinishedMessage({
        clientName: "Vasco Warranty",
        campaignName: "Vasco - Signal - Warranty Admin Hiring",
        otherActiveLeads: false,
      }),
      /finished the list/,
    );
  });

  it("does not attribute another client's day volume to BCP", () => {
    const text = formatDailyDigest("2026-09-01", [
      row({
        clientId: 542838,
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Healthcare Under-1k (No Team)",
        sent: 0,
        remaining: 5328,
        inProgress: 5328,
      }),
      row({
        clientId: 542838,
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Healthcare Over-1k (With Team)",
        sent: 0,
        remaining: 620,
        inProgress: 620,
      }),
      row({
        clientId: 999001,
        clientName: "Culture Fits",
        campaignName: "Healthcare Under-1k No Team",
        sent: 5328,
        remaining: 100,
        inProgress: 100,
      }),
      row({
        clientId: null,
        clientName: "Unknown client",
        campaignName: "Fleet leftover",
        sent: 5294,
        remaining: 10,
        inProgress: 10,
      }),
    ]);
    assert.match(text ?? "", /\*Bolder Cyber Partners\* — 0 sent/);
    assert.doesNotMatch(text ?? "", /\*Bolder Cyber Partners\* — 5,948 sent/);
    assert.match(text ?? "", /\*Culture Fits\* — 5,328 sent/);
    assert.match(text ?? "", /\*Unknown client\* — 5,294 sent/);
    assert.match(text ?? "", /Healthcare Under-1k \(No Team\) — 0 sent/);
  });

  it("asks for a refill when a campaign is nearly done", () => {
    const at75 = formatNearlyDoneMessage({
      clientName: "Vasco Warranty",
      campaignName: "Vasco - Signal - Warranty Admin Hiring",
      threshold: 75,
      remaining: 238,
    });
    const at90 = formatNearlyDoneMessage({
      clientName: "Goliath Cybersecurity",
      campaignName: "Goliath Displacement L 501-1000 ITDir",
      threshold: 90,
      remaining: 40,
    });
    assert.equal(
      at75,
      "*Vasco Warranty* — *Vasco - Signal - Warranty Admin Hiring* is nearly done (75%, 238 left). Refill soon.",
    );
    assert.equal(
      at90,
      "*Goliath Cybersecurity* — *Goliath Displacement L 501-1000 ITDir* is nearly done (90%, 40 left). Refill soon.",
    );
    assert.doesNotMatch(at75, /100\.0% through the list/);
    assert.doesNotMatch(at75, /50% completion/);
  });

  it("says whether the finished client still has anything sending", () => {
    const stillSending = formatFinishedMessage({
      clientName: "Vasco Warranty",
      campaignName: "Vasco - Signal - Warranty Admin Hiring",
      otherActiveLeads: true,
    });
    const dark = formatFinishedMessage({
      clientName: "Vasco Warranty",
      campaignName: "Vasco - Signal - Warranty Admin Hiring",
      otherActiveLeads: false,
    });
    assert.equal(
      stillSending,
      "*Vasco Warranty* — *Vasco - Signal - Warranty Admin Hiring* finished the list. This client still has other active campaigns with leads left.",
    );
    assert.equal(
      dark,
      "*Vasco Warranty* — *Vasco - Signal - Warranty Admin Hiring* finished the list. This client now has nothing sending — flag for a lead refill.",
    );
  });
});
