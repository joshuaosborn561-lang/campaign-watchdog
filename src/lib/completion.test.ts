import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clientHasOtherActiveLeads,
  completionAlertsToPost,
  completionPercent,
  newThresholds,
  parseCampaignLeadStats,
  parseSentCount,
  thresholdsReached,
} from "./completion.js";
import { isCompletionIgnoredCampaign } from "./names.js";

describe("completion", () => {
  it("parses Smartlead campaign lead totals", () => {
    const stats = parseCampaignLeadStats({
      data: { total_leads: 1000, leads_contacted: 750, leads_replied: 40 },
    });
    assert.ok(stats);
    assert.equal(stats.total, 1000);
    assert.equal(stats.contacted, 750);
    assert.equal(stats.remaining, 250);
    assert.equal(completionPercent(stats), 75);
  });

  it("uses not_started when contacted is missing", () => {
    const stats = parseCampaignLeadStats({
      campaign_lead_stats: { total: 200, not_started: 50 },
    });
    assert.ok(stats);
    assert.equal(stats.contacted, 150);
    assert.equal(completionPercent(stats), 75);
  });

  it("uses Smartlead analytics drafted_count as remaining", () => {
    const stats = parseCampaignLeadStats({
      total_count: "2038",
      drafted_count: "254",
      sent_count: "0",
      unique_sent_count: "1784",
    });
    assert.ok(stats);
    assert.equal(stats.total, 2038);
    assert.equal(stats.remaining, 254);
    assert.equal(stats.contacted, 1784);
  });

  it("counts in-progress follow-ups, not just notStarted", () => {
    const stats = parseCampaignLeadStats({
      total_count: "1815",
      drafted_count: "1081",
      unique_sent_count: "553",
      campaign_lead_stats: {
        total: 553,
        notStarted: 0,
        inprogress: 393,
        completed: 29,
      },
    });
    assert.ok(stats);
    assert.equal(stats.remaining, 393);
    assert.equal(stats.notStarted, 0);
    assert.equal(stats.inProgress, 393);
  });

  it("returns 50/75/90/100 crossings only once", () => {
    assert.deepEqual(thresholdsReached(49.9, [50, 75, 90, 100]), []);
    assert.deepEqual(thresholdsReached(50, [50, 75, 90, 100]), [50]);
    assert.deepEqual(thresholdsReached(90, [50, 75, 90, 100]), [50, 75, 90]);
    assert.deepEqual(thresholdsReached(99.6, [50, 75, 90, 100]), [50, 75, 90, 100]);
    assert.deepEqual(newThresholds(92, [50, 75], [50, 75, 90, 100]), [90]);
  });

  it("Slacks 75 and 90 but not 50, and never 75/90 when already 100%", () => {
    assert.deepEqual(completionAlertsToPost([50], 51), []);
    assert.deepEqual(completionAlertsToPost([50, 75], 76), [75]);
    assert.deepEqual(completionAlertsToPost([90], 91), [90]);
    assert.deepEqual(completionAlertsToPost([50, 75, 90], 91), [75, 90]);
    assert.deepEqual(completionAlertsToPost([50, 75, 90, 100], 100), [100]);
    assert.deepEqual(completionAlertsToPost([75, 90, 100], 99.6), [100]);
    assert.deepEqual(completionAlertsToPost([75, 90], 100), []);
    assert.deepEqual(completionAlertsToPost([], 80), []);
  });

  it("treats another ACTIVE list with leftover leads as still sending", () => {
    const rows = [
      {
        id: 1,
        clientId: 10,
        clientName: "Vasco Warranty",
        campaignName: "Vasco - Signal - Warranty Admin Hiring",
        status: "ACTIVE",
        remaining: 0,
      },
      {
        id: 2,
        clientId: 10,
        clientName: "Vasco Warranty",
        campaignName: "Vasco - Service - Standard Brands",
        status: "ACTIVE",
        remaining: 240,
      },
    ];
    assert.equal(
      clientHasOtherActiveLeads(
        { id: 1, clientId: 10, clientName: "Vasco Warranty" },
        rows,
        isCompletionIgnoredCampaign,
      ),
      true,
    );
  });

  it("does not count Generic, shells, paused, or empty siblings as still sending", () => {
    const finishing = { id: 1, clientId: 10, clientName: "Bolder Cyber Partners" };
    const rows = [
      {
        id: 1,
        clientId: 10,
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Healthcare Under-1k (With Team)",
        status: "ACTIVE",
        remaining: 0,
      },
      {
        id: 2,
        clientId: 10,
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Generic (With Team)",
        status: "ACTIVE",
        remaining: 40000,
      },
      {
        id: 3,
        clientId: 10,
        clientName: "Bolder Cyber Partners",
        campaignName: "Canary shell: #3763797",
        status: "ACTIVE",
        remaining: 1,
      },
      {
        id: 4,
        clientId: 10,
        clientName: "Bolder Cyber Partners",
        campaignName: "Word-hunt shell: BCP probe",
        status: "ACTIVE",
        remaining: 1,
      },
      {
        id: 5,
        clientId: 10,
        clientName: "Bolder Cyber Partners",
        campaignName: "BCP Healthcare Under-1k (No Team)",
        status: "PAUSED",
        remaining: 800,
      },
    ];
    assert.equal(
      clientHasOtherActiveLeads(finishing, rows, isCompletionIgnoredCampaign),
      false,
    );
  });

  it("assumes a sibling is still sending when remaining is unknown", () => {
    assert.equal(
      clientHasOtherActiveLeads(
        { id: 1, clientId: 7, clientName: "Parlay Tech" },
        [
          {
            id: 2,
            clientId: 7,
            clientName: "Parlay Tech",
            campaignName: "Parlay EOS Sales DM Choice",
            status: "ACTIVE",
            remaining: null,
          },
        ],
        isCompletionIgnoredCampaign,
      ),
      true,
    );
  });

  it("reads sent_count from analytics-by-date", () => {
    assert.equal(parseSentCount({ sent_count: "180" }), 180);
    assert.equal(parseSentCount({ data: { total_sent: 12 } }), 12);
  });
});
