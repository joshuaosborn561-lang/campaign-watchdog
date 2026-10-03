import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import {
  DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS,
  DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES,
} from "./lib/pulse.js";

describe("loadConfig", () => {
  it("defaults the Slack channel and 50/75/90/100 thresholds", () => {
    const config = loadConfig({
      SMARTLEAD_API_KEY: "sl-key",
      SLACK_BOT_TOKEN: "xoxb-test",
    } as NodeJS.ProcessEnv);
    assert.equal(config.slackChannelId, "C0BT978GSAC");
    assert.deepEqual(config.completionThresholds, [50, 75, 90, 100]);
    assert.equal(config.messagePerDay, 30);
    assert.equal(config.sendShortfallTimezone, "America/Chicago");
    assert.equal(config.pulseCron, "5 8,10,12,14,16 * * 1-5");
    assert.deepEqual(config.pulseHours, [8, 10, 12, 14, 16]);
    assert.deepEqual(config.pulseWeekdays, [1, 2, 3, 4, 5]);
    assert.deepEqual(config.heyreachWorkspaces, []);
    assert.deepEqual(config.heyreachExcludeIds, [530529]);
    assert.equal(config.heyreachRunwayDays, 7);
    assert.deepEqual(config.pulseExcludeCampaignIds, DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS);
    assert.deepEqual(config.pulseExcludeCampaignNames, DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES);
    assert.ok(config.pulseExcludeCampaignNames.includes("MSRS Ticket Offer Propert Manager"));
    assert.equal(config.volumeCron, "10 12 * * 1-5");
    assert.equal(config.volumeHour, 12);
    assert.deepEqual(config.volumeWeekdays, [1, 2, 3, 4, 5]);
    assert.equal(config.volumeTargetSends, 1200);
    assert.equal(config.volumeAlertMax, 1080);
    assert.equal(config.eodCron, "30 17 * * 1-5");
    assert.equal(config.eodHour, 17);
  });

  it("merges extra pulse exclude ids and names onto the built-in defaults", () => {
    const config = loadConfig({
      SMARTLEAD_API_KEY: "sl-key",
      SLACK_BOT_TOKEN: "xoxb-test",
      PULSE_EXCLUDE_CAMPAIGN_IDS: "111,3628943",
      PULSE_EXCLUDE_CAMPAIGN_NAMES: "Extra Leftover\npositive",
    } as NodeJS.ProcessEnv);
    assert.ok(config.pulseExcludeCampaignIds.includes(111));
    assert.ok(config.pulseExcludeCampaignIds.includes(3628943));
    assert.ok(config.pulseExcludeCampaignIds.includes(3437329));
    assert.ok(config.pulseExcludeCampaignNames.includes("Extra Leftover"));
    assert.ok(config.pulseExcludeCampaignNames.includes("Positive"));
    assert.equal(
      config.pulseExcludeCampaignNames.filter((name) => name.toLowerCase() === "positive").length,
      1,
    );
  });

  it("reads HeyReach workspace keys from Railway env and skips master", () => {
    const config = loadConfig({
      SMARTLEAD_API_KEY: "sl-key",
      SLACK_BOT_TOKEN: "xoxb-test",
      HEYREACH_SALESGLIDER_API_KEY: "sg-key",
      HEYREACH_TECHEVO_API_KEY: "te-key",
      HEYREACH_MASTER_API_KEY: "org-key-must-skip",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(
      config.heyreachWorkspaces.map((row) => ({ id: row.id, clientName: row.clientName })),
      [
        { id: "salesglider", clientName: "SalesGlider" },
        { id: "techevo", clientName: "TechEvolution" },
      ],
    );
    assert.equal(
      config.heyreachWorkspaces.some((row) => /master/i.test(row.id) || row.apiKey === "org-key-must-skip"),
      false,
    );
  });
});
