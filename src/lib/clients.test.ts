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

describe("sg-owner tag attribution (Smartlead spaces deleted 2026-11-11)", () => {
  const BCP_ID = 542838;
  const tag = (slug: string) => ({ tag_id: 1, tag_name: `sg-owner:${slug}`, tag_color: null });

  it("a tagged campaign with client_id null resolves to the catalog id and name", () => {
    const resolved = resolveClient(
      { id: 40, client_id: null, tags: [tag("bcp")] },
      new Map(),
      new Map(),
      new Map(),
    );
    assert.deepEqual(resolved, { clientId: BCP_ID, clientName: "Bolder Cyber Partners", ownerSlug: "bcp" });
  });

  it("prefers the registry name for the tag's legacy id", () => {
    const resolved = resolveClient(
      { id: 41, client_id: null, tags: [tag("parlay")] },
      new Map(),
      new Map(),
      new Map([[418274, "Parlay Tech (registry)"]]),
    );
    assert.equal(resolved.clientId, 418274);
    assert.equal(resolved.clientName, "Parlay Tech (registry)");
  });

  it("reads the tag from campaign detail when the list row has none", () => {
    const resolved = resolveClient(
      { id: 42, client_id: null },
      new Map(),
      new Map(),
      new Map(),
      { data: { id: 42, tags: [tag("emcor")] } },
    );
    assert.equal(resolved.clientId, 574020);
  });

  it("the tag beats a conflicting stale Supabase smartlead_client_id and name", () => {
    const resolved = resolveClient(
      { id: 43, client_id: null, tags: [tag("goliath")] },
      new Map(),
      new Map([
        [
          43,
          {
            smartlead_campaign_id: 43,
            name: "x",
            client_name: "Bolder Cyber Partners",
            smartlead_client_id: BCP_ID,
          },
        ],
      ]),
      new Map([[BCP_ID, "Bolder Cyber Partners"]]),
    );
    assert.equal(resolved.clientId, 548611);
    assert.equal(resolved.clientName, "Goliath Cybersecurity");
  });

  it("the tag beats a conflicting Smartlead client_id too", () => {
    const resolved = resolveClient(
      { id: 44, client_id: BCP_ID, tags: [tag("techevo")] },
      new Map(),
      new Map(),
      new Map(),
    );
    assert.equal(resolved.clientId, 521881);
  });

  it("untagged with no mapping stays Unknown client", () => {
    assert.deepEqual(
      resolveClient({ id: 45, client_id: null, tags: [] }, new Map(), new Map(), new Map()),
      { clientId: null, clientName: "Unknown client" },
    );
  });

  it("untagged still falls back to the Supabase id (step c) exactly as before", () => {
    const resolved = resolveClient(
      { id: 46, client_id: null, tags: [{ tag_name: "Healthcare" }] },
      new Map(),
      new Map([
        [46, { smartlead_campaign_id: 46, name: "x", client_name: "Bolder Cyber Partners", smartlead_client_id: BCP_ID }],
      ]),
      new Map(),
    );
    assert.deepEqual(resolved, { clientId: BCP_ID, clientName: "Bolder Cyber Partners" });
  });

  it("two distinct sg-owner tags are ambiguous: unowned, even with a Supabase id", () => {
    const resolved = resolveClient(
      { id: 47, client_id: null, tags: [tag("bcp"), tag("parlay")] },
      new Map(),
      new Map([
        [47, { smartlead_campaign_id: 47, name: "x", client_name: "Bolder Cyber Partners", smartlead_client_id: BCP_ID }],
      ]),
      new Map(),
    );
    assert.deepEqual(resolved, { clientId: null, clientName: "Unknown client" });
  });

  it("a list-row tag and a different detail tag are ambiguous too", () => {
    const resolved = resolveClient(
      { id: 48, client_id: null, tags: [tag("bcp")] },
      new Map(),
      new Map(),
      new Map(),
      { tags: [tag("parlay")] },
    );
    assert.equal(resolved.clientId, null);
    assert.equal(resolved.clientName, "Unknown client");
  });

  it("ciotola resolves to its slug and name, inactive, with no numeric id", () => {
    const resolved = resolveClient(
      { id: 49, client_id: 345263, tags: [tag("ciotola")] },
      new Map(),
      new Map(),
      new Map([[345263, "SalesGlider"]]),
    );
    assert.deepEqual(resolved, {
      clientId: null,
      clientName: "Ciotola",
      ownerSlug: "ciotola",
      inactive: true,
    });
  });

  it("deeproots tag resolves to Deep Roots legacy id 597783", () => {
    const resolved = resolveClient(
      { id: 50, client_id: null, tags: [tag("deeproots")] },
      new Map(),
      new Map(),
      new Map(),
    );
    assert.equal(resolved.clientId, 597783);
    assert.equal(resolved.ownerSlug, "deep_roots");
  });

  it("an sg-owner slug missing from the catalog gets a name but never an id", () => {
    const resolved = resolveClient(
      { id: 51, client_id: null, tags: [tag("newco")] },
      new Map(),
      new Map([[51, { smartlead_campaign_id: 51, name: "x", client_name: "BCP", smartlead_client_id: BCP_ID }]]),
      new Map(),
    );
    assert.deepEqual(resolved, { clientId: null, clientName: "newco", ownerSlug: "newco" });
  });
});
