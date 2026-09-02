import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientGroupKey, clientIdFrom, resolveClient } from "./clients.js";

const BCP = 542838;
const GOLIATH = 999001;

describe("client attribution", () => {
  it("uses Smartlead client_id + registry for a tagged BCP campaign", () => {
    const resolved = resolveClient(
      { id: 10, client_id: BCP },
      new Map(),
      new Map(),
      new Map([[BCP, "Bolder Cyber Partners"]]),
    );
    assert.deepEqual(resolved, { clientId: BCP, clientName: "Bolder Cyber Partners" });
  });

  it("leaves an untagged campaign as Unknown client", () => {
    const resolved = resolveClient(
      { id: 11, client_id: null },
      new Map([[BCP, { id: BCP, name: "BCP" }]]),
      new Map(),
      new Map([[BCP, "Bolder Cyber Partners"]]),
    );
    assert.deepEqual(resolved, { clientId: null, clientName: "Unknown client" });
  });

  it("does not move another client's volume onto BCP via a stale supabase name", () => {
    const resolved = resolveClient(
      {
        id: 20,
        client_id: GOLIATH,
      },
      new Map([[GOLIATH, { id: GOLIATH, name: "Goliath Cybersecurity" }]]),
      new Map([
        [
          20,
          {
            smartlead_campaign_id: 20,
            name: "Healthcare Under-1k No Team",
            client_name: "Bolder Cyber Partners",
            smartlead_client_id: BCP,
          },
        ],
      ]),
      new Map([
        [BCP, "Bolder Cyber Partners"],
        [GOLIATH, "Goliath Cybersecurity"],
      ]),
    );
    assert.equal(resolved.clientId, GOLIATH);
    assert.equal(resolved.clientName, "Goliath Cybersecurity");
    assert.notEqual(resolved.clientName, "Bolder Cyber Partners");
  });

  it("does not use supabase client_name when it disagrees with Smartlead client_id", () => {
    const resolved = resolveClient(
      { id: 3815484, client_id: 1 },
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
    assert.deepEqual(resolved, { clientId: 1, clientName: "Client 1" });
  });

  it("reads nested client.id from campaign detail when the list row is untagged", () => {
    const resolved = resolveClient(
      { id: 30, client_id: null },
      new Map(),
      new Map(),
      new Map([[BCP, "Bolder Cyber Partners"]]),
      { client: { id: BCP, name: "BCP" } },
    );
    assert.deepEqual(resolved, { clientId: BCP, clientName: "Bolder Cyber Partners" });
  });

  it("reads client_id from a detail payload", () => {
    assert.equal(clientIdFrom({ client_id: "542838" }), BCP);
    assert.equal(clientIdFrom({ client: { id: GOLIATH } }), GOLIATH);
    assert.equal(clientIdFrom({ data: { clientId: 12 } }), 12);
  });

  it("keeps different client ids in separate rollup keys even if names collide", () => {
    assert.equal(
      clientGroupKey({ clientId: BCP, clientName: "Bolder Cyber Partners" }),
      "id:542838",
    );
    assert.equal(
      clientGroupKey({ clientId: GOLIATH, clientName: "Bolder Cyber Partners" }),
      "id:999001",
    );
    assert.equal(
      clientGroupKey({ clientId: null, clientName: "Unknown client" }),
      "name:Unknown client",
    );
  });
});
