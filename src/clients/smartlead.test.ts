import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ForbiddenCampaignStatusError,
  SmartleadClient,
  assertAllowedCampaignStatus,
  isForbiddenCampaignStatus,
} from "./smartlead.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchSpy(): { calls: Array<{ url: string; method: string; body: string }> } {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("Smartlead campaign status guard", () => {
  it("classifies PAUSED and STOPPED as forbidden in any case", () => {
    assert.equal(isForbiddenCampaignStatus("PAUSED"), true);
    assert.equal(isForbiddenCampaignStatus("paused"), true);
    assert.equal(isForbiddenCampaignStatus("STOPPED"), true);
    assert.equal(isForbiddenCampaignStatus("stopped"), true);
    assert.equal(isForbiddenCampaignStatus("START"), false);
    assert.equal(isForbiddenCampaignStatus("ACTIVE"), false);
  });

  it("throws and does not treat PAUSED or STOPPED as allowed", () => {
    assert.throws(
      () => assertAllowedCampaignStatus(88, "PAUSED"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError &&
        error.campaignId === 88 &&
        error.status === "PAUSED",
    );
    assert.throws(
      () => assertAllowedCampaignStatus(88, "stopped"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError && error.status === "STOPPED",
    );
    assert.equal(assertAllowedCampaignStatus(88, "START"), "START");
  });

  it("refuses PAUSED without calling the Smartlead API", async () => {
    const { calls } = installFetchSpy();
    const client = new SmartleadClient("test-key");
    await assert.rejects(
      () => client.updateCampaignStatus(101, "PAUSED"),
      (error: unknown) =>
        error instanceof ForbiddenCampaignStatusError &&
        /refused Smartlead status change to PAUSED/.test(error.message),
    );
    assert.deepEqual(calls, []);
  });

  it("refuses STOPPED without calling the Smartlead API", async () => {
    const { calls } = installFetchSpy();
    const client = new SmartleadClient("test-key");
    await assert.rejects(
      () => client.updateCampaignStatus(102, "STOPPED"),
      ForbiddenCampaignStatusError,
    );
    assert.deepEqual(calls, []);
  });

  it("allows START through to Smartlead", async () => {
    const { calls } = installFetchSpy();
    const client = new SmartleadClient("test-key");
    const result = await client.updateCampaignStatus(103, "START");
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /campaigns\/103\/status/);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.body, JSON.stringify({ status: "START" }));
  });
});

describe("Smartlead tags + client catalog (spaces deleted 2026-11-11)", () => {
  function installJsonFetch(byPath: (url: URL) => unknown): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      return new Response(JSON.stringify(byPath(new URL(url))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return urls;
  }

  it("listCampaigns and getCampaign request include_tags=true and carry tags", async () => {
    const urls = installJsonFetch((url) =>
      url.pathname.endsWith("/campaigns/")
        ? [
            {
              id: 7,
              name: "BCP Lane",
              status: "ACTIVE",
              client_id: null,
              tags: [{ tag_id: 3, tag_name: "sg-owner:bcp", tag_color: "#000" }],
            },
          ]
        : { id: 7, tags: [] },
    );
    const client = new SmartleadClient("k");
    const rows = await client.listCampaigns();
    await client.getCampaign(7);
    assert.equal(urls.length, 2);
    for (const raw of urls) assert.equal(new URL(raw).searchParams.get("include_tags"), "true");
    assert.deepEqual(rows[0]?.tags, [{ tag_id: 3, tag_name: "sg-owner:bcp", tag_color: "#000" }]);
    assert.equal(rows[0]?.client_id, null);
  });

  it("listClients serves the owner catalog when live /client returns []", async () => {
    installJsonFetch(() => []);
    const clients = await new SmartleadClient("k").listClients();
    const byId = new Map(clients.map((row) => [row.id, row]));
    assert.equal(byId.get(542838)?.logo, "Bolder Cyber Partners");
    assert.equal(byId.get(607625)?.name, "Virtual Pulsar");
    assert.ok(clients.length >= 17);
  });

  it("listClients still serves the catalog when the live call fails, and merges live rows", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const offline = await new SmartleadClient("k").listClients();
    assert.ok(offline.some((row) => row.id === 345263));

    installJsonFetch(() => [{ id: 999, name: "Revived space", logo: "Revived" }]);
    const merged = await new SmartleadClient("k").listClients();
    assert.ok(merged.some((row) => row.id === 999 && row.logo === "Revived"));
    assert.ok(merged.some((row) => row.id === 542838));
  });
});
