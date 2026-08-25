import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveClientName } from "./watch.js";

describe("resolveClientName", () => {
  it("prefers the campaignintelligence client_name", () => {
    const name = resolveClientName(
      { id: 3815484, name: "Vasco - Signal - Warranty Admin Hiring", status: "ACTIVE", client_id: 1 },
      new Map(),
      new Map([
        [
          3815484,
          {
            smartlead_campaign_id: 3815484,
            name: "Vasco - Signal - Warranty Admin Hiring",
            client_name: "Vasco Warranty",
            smartlead_client_id: 548609,
          },
        ],
      ]),
      new Map(),
    );
    assert.equal(name, "Vasco Warranty");
  });

  it("falls back to Smartlead client + registry", () => {
    const name = resolveClientName(
      { id: 1, name: "BCP PE Firms (No Team)", status: "PAUSED", client_id: 542838 },
      new Map([[542838, { id: 542838, name: "BCP" }]]),
      new Map(),
      new Map([[542838, "Bolder Cyber Partners"]]),
    );
    assert.equal(name, "Bolder Cyber Partners");
  });
});
