import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCanaryShell,
  isCompletionIgnoredCampaign,
  isGenericCampaign,
  isNoiseCampaign,
  isWordHuntShell,
  shortCampaignName,
} from "./names.js";

describe("campaign names", () => {
  it("drops canary shells from Slack", () => {
    assert.equal(isCanaryShell("Canary shell: #3763800"), true);
    assert.equal(isCanaryShell("Canary_shell #3763800"), true);
    assert.equal(isCanaryShell("Canary BCP probe"), true);
    assert.equal(isNoiseCampaign("Canary shell: #3763800"), true);
    assert.equal(isNoiseCampaign("Pod control shell"), true);
    assert.equal(isCanaryShell("BCP Healthcare Under-1k (No Team)"), false);
    assert.equal(isNoiseCampaign("BCP Healthcare Under-1k (No Team)"), false);
  });

  it("drops word-hunt shells from Slack", () => {
    assert.equal(isWordHuntShell("Word-hunt shell: BCP probe"), true);
    assert.equal(isWordHuntShell("Word_hunt_shell #12"), true);
    assert.equal(isWordHuntShell("Word hunt BCP probe"), true);
    assert.equal(isNoiseCampaign("Word-hunt shell: BCP probe"), true);
    assert.equal(isWordHuntShell("BCP Healthcare Under-1k (No Team)"), false);
  });

  it("recognizes generic lists", () => {
    assert.equal(isGenericCampaign("BCP Generic (With Team)"), true);
    assert.equal(isGenericCampaign("BCP Healthcare Under-1k (No Team)"), false);
    assert.equal(isCompletionIgnoredCampaign("BCP Generic (With Team)"), true);
    assert.equal(isCompletionIgnoredCampaign("BCP Healthcare Under-1k (No Team)"), false);
    assert.equal(isCompletionIgnoredCampaign("Canary shell: #3763800"), true);
    assert.equal(isCompletionIgnoredCampaign("Word-hunt shell: BCP probe"), true);
  });

  it("shortens campaign names without dropping the useful bit", () => {
    assert.equal(
      shortCampaignName("TechEvolution", "TechEvo New England Red Sox"),
      "New England Red Sox",
    );
    assert.equal(
      shortCampaignName("Bolder Cyber Partners", "BCP Healthcare Under-1k (With Team)"),
      "Healthcare Under-1k (With Team)",
    );
  });
});
