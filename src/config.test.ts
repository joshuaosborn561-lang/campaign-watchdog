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
  });
});
