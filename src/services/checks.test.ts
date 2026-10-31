import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { ChecksService } from "./checks.js";
import { ChecksStore } from "../state/checks-store.js";
import type { SmartleadCampaign } from "../clients/smartlead.js";

const NOW = new Date("2026-10-28T15:05:00Z"); // Wed 10:05am CT

function makeConfig(env: Record<string, string> = {}) {
  return loadConfig({
    SMARTLEAD_API_KEY: "k",
    SLACK_BOT_TOKEN: "x",
    ...env,
  } as NodeJS.ProcessEnv);
}

function fakeSmartlead(campaigns: SmartleadCampaign[]) {
  const calls: Array<{ id: number; status: string }> = [];
  const status = new Map(campaigns.map((c) => [c.id, c.status]));
  const client = {
    calls,
    listCampaigns: async () => campaigns.map((c) => ({ ...c, status: status.get(c.id) ?? c.status })),
    listClients: async () => [
      { id: 10, name: "Peterson" },
      { id: 20, name: "Goliath" },
    ],
    getCampaign: async (id: number) => ({ id, status: status.get(id) }),
    getCampaignEmailAccounts: async () => [{ id: 1 }, { id: 2 }],
    getCampaignAnalytics: async () => ({
      campaign_lead_stats: { total: 100, notStarted: 50, inprogress: 5 },
    }),
    getCampaignStatisticsPage: async () => ({ total_stats: 30, data: [] }),
    updateCampaignStatus: async (id: number, s: string) => {
      calls.push({ id, status: s });
      status.set(id, "ACTIVE");
      return {};
    },
  };
  return client;
}

const slackPosts: string[] = [];
const fakeSlack = { post: async (t: string) => void slackPosts.push(t), tokenBundle: () => ({ accessToken: "x" }) };
const fakeSupabase = {
  enabled: () => false,
  fetchCampaignNames: async () => new Map(),
  fetchClientRegistry: async () => new Map(),
};

function build(campaigns: SmartleadCampaign[], env: Record<string, string> = {}) {
  const sl = fakeSmartlead(campaigns);
  const store = new ChecksStore(path.join(tmpdir(), `checks-test-${Math.random()}.json`));
  const service = new ChecksService(
    makeConfig(env),
    sl as never,
    fakeSlack as never,
    fakeSupabase as never,
    store,
  );
  return { sl, store, service };
}

const camps: SmartleadCampaign[] = [
  { id: 1, name: "Peterson C2", status: "PAUSED", client_id: 10 },
  { id: 2, name: "Peterson C3", status: "STOPPED", client_id: 10 },
  { id: 3, name: "Goliath A", status: "PAUSED", client_id: 20 },
  { id: 3851730, name: "Goliath held", status: "PAUSED", client_id: 20 },
  { id: 5, name: "Shell", status: "PAUSED", client_id: null },
];

describe("ChecksService paused sweep", () => {
  it("defaults to dry-run: lists what it would start and never writes status", async () => {
    const { sl, service } = build(camps);
    assert.equal(service["config"].pausedSweepMode, "dry-run");
    const report = await service.runPausedSweep({ now: NOW });
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.wouldStart.map((r) => r.id).sort(), [1, 3]);
    assert.equal(sl.calls.length, 0);
    // STOPPED campaigns are never even candidates
    assert.equal(report.wouldStart.some((r) => r.id === 2), false);
    assert.ok(report.skipped.some((r) => r.id === 3851730 && r.reason === "held on purpose"));
    assert.equal(report.noClientPaused, 1);
  });

  it("forceDryRun beats a live configured mode", async () => {
    const { sl, service } = build(camps, { PAUSED_SWEEP_MODE: "live" });
    const report = await service.runPausedSweep({ now: NOW, forceDryRun: true });
    assert.equal(report.mode, "dry-run");
    assert.equal(sl.calls.length, 0);
  });

  it("live mode STARTs only PAUSED campaigns, never a STOPPED one", async () => {
    slackPosts.length = 0;
    const { sl, service } = build(camps, { PAUSED_SWEEP_MODE: "live" });
    const report = await service.runPausedSweep({ now: NOW });
    assert.deepEqual(sl.calls.map((c) => c.id).sort(), [1, 3]);
    assert.ok(sl.calls.every((c) => c.status === "START"));
    assert.equal(sl.calls.some((c) => c.id === 2), false);
    assert.equal(report.started.length, 2);
    assert.equal(slackPosts.length, 1);
    assert.match(slackPosts[0], /Restarted paused campaigns/);
  });

  it("re-checks status right before START: a campaign that went STOPPED is skipped", async () => {
    const { sl, service } = build(camps, { PAUSED_SWEEP_MODE: "live" });
    // list says PAUSED, but the live read says STOPPED
    sl.getCampaign = async (id: number) => ({ id, status: id === 1 ? "STOPPED" : "PAUSED" });
    const report = await service.runPausedSweep({ now: NOW });
    assert.equal(sl.calls.some((c) => c.id === 1), false);
    assert.ok(report.skipped.some((r) => r.id === 1 && r.reason === "stopped"));
  });

  it("off does nothing; live outside weekday hours does nothing", async () => {
    const off = build(camps, { PAUSED_SWEEP_MODE: "off" });
    assert.equal((await off.service.runPausedSweep({ now: NOW })).ran, false);
    const live = build(camps, { PAUSED_SWEEP_MODE: "live" });
    const saturday = new Date("2026-10-31T15:00:00Z");
    const report = await live.service.runPausedSweep({ now: saturday });
    assert.equal(report.ran, false);
    assert.equal(live.sl.calls.length, 0);
  });

  it("leaves a campaign paused when its senders can't be read", async () => {
    const { sl, service } = build(camps, { PAUSED_SWEEP_MODE: "live" });
    sl.getCampaignEmailAccounts = (async () => {
      throw new Error("boom");
    }) as never;
    const report = await service.runPausedSweep({ now: NOW });
    assert.equal(sl.calls.length, 0);
    assert.ok(report.errors.length >= 1);
  });
});

describe("ChecksService leads check", () => {
  it("is read-only in dry-run and flags lanes by days left", async () => {
    slackPosts.length = 0;
    const active: SmartleadCampaign[] = [
      { id: 11, name: "Peterson Lane A", status: "ACTIVE", client_id: 10 },
      { id: 12, name: "Peterson Lane B", status: "ACTIVE", client_id: 10 },
    ];
    const { sl, service } = build(active);
    sl.getCampaignAnalytics = async (id: number) => ({
      campaign_lead_stats: { total: 100, notStarted: id === 11 ? 0 : 20, inprogress: 5 },
    });
    // 30 first touches over 3 weekdays = 10/day, 20 left = 2.0 days, not < 2
    const report = await service.runLeadsCheck({ now: NOW });
    assert.equal(report.mode, "dry-run");
    assert.equal(slackPosts.length, 0);
    assert.deepEqual(report.flagged.map((r) => [r.id, r.kind]), [[11, "dry"]]);
    assert.equal(sl.calls.length, 0);
  });
});
