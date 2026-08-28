import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGenericCampaign, isNoiseCampaign, shortCampaignName } from "./names.js";

describe("campaign names", () => {
  it("drops canary shells from Slack", () => {
    assert.equal(isNoiseCampaign("Canary shell: #3763800"), true);
    assert.equal(isNoiseCampaign("Canary BCP probe"), true);
    assert.equal(isNoiseCampaign("Pod control shell"), true);
    assert.equal(isNoiseCampaign("BCP Healthcare Under-1k (No Team)"), false);
  });

  it("recognizes generic lists", () => {
    assert.equal(isGenericCampaign("BCP Generic (With Team)"), true);
    assert.equal(isGenericCampaign("BCP Healthcare Under-1k (No Team)"), false);
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
