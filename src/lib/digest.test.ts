import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatDailyDigest,
  formatFinishedMessage,
  formatPauseMessage,
  rollupClients,
  shortCampaignName,
  type DigestCampaign,
} from "./digest.js";

function row(partial: Partial<DigestCampaign> & Pick<DigestCampaign, "clientName" | "campaignName">): DigestCampaign {
  return {
    sent: 0,
    remaining: 0,
    notStarted: 0,
    inProgress: 0,
    staffable: 1,
    attached: 1,
    kind: "ok_on_pace",
    shouldAlert: false,
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

  it("rolls TechEvo up as a client staffing problem", () => {
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
        sent: 5,
        remaining: 133,
        notStarted: 128,
        inProgress: 5,
      }),
    ]);
    assert.equal(clients[0].severity, "problem");
    assert.match(clients[0].line, /\*TechEvolution\*/);
    assert.match(clients[0].line, /1 inbox on every campaign/);
    assert.match(clients[0].line, /New England Red Sox 0 sent/);
    assert.doesNotMatch(clients[0].line, /TechEvo SFL IT DM AirPods/);
  });

  it("names one stalled Parlay campaign and leaves the drip at the client", () => {
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
    assert.match(parlay.line, /dripped 12–28/);
    assert.match(parlay.line, /\*Sports Offer - copy\*/);
    assert.match(parlay.line, /0 sent \/ 1,178 follow-ups/);
    assert.doesNotMatch(parlay.line, /EOS Sales DM Choice 28 sent/);
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
    assert.match(clients[0].line, /3 campaigns sent 0/);
    assert.match(clients[0].line, /\*Staffing\* 509/);
    assert.doesNotMatch(clients[0].line, /Financial Advisors\* 0 sent/);
  });

  it("keeps Goliath as a short fine line", () => {
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
    assert.match(clients[0].line, /sending \(13–80\)/);
  });

  it("writes a short daily post with problems first", () => {
    const text = formatDailyDigest("2026-08-25", [
      { clientName: "TechEvolution", severity: "problem", line: "*TechEvolution* — 1 inbox on every campaign." },
      { clientName: "Goliath Cybersecurity", severity: "fine", line: "*Goliath Cybersecurity* — sending (13–80)." },
    ]);
    assert.match(text ?? "", /Tue 8\/25/);
    assert.ok((text ?? "").indexOf("TechEvolution") < (text ?? "").indexOf("Fine"));
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
      }),
      /finished the list/,
    );
  });
});
