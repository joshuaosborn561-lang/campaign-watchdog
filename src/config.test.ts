import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

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
    assert.equal(config.pulseCron, "5 8,10,12,14,16 * * 1-4");
    assert.deepEqual(config.pulseHours, [8, 10, 12, 14, 16]);
    assert.deepEqual(config.pulseWeekdays, [1, 2, 3, 4]);
    assert.deepEqual(config.heyreachWorkspaces, []);
    assert.deepEqual(config.heyreachExcludeIds, [530529]);
    assert.equal(config.heyreachRunwayDays, 7);
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
