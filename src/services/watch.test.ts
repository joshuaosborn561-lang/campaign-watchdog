import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SmartleadCampaign, SmartleadClientRecord } from "../clients/smartlead.js";
import type { CampaignNameRow } from "../clients/supabase.js";
import { resolveClientName } from "./watch.js";
import { WatchService } from "./watch.js";
import { StateStore } from "../state/store.js";

const BCP = 542838;

function campaign(
  partial: Partial<SmartleadCampaign> & Pick<SmartleadCampaign, "id" | "name">,
): SmartleadCampaign {
  return {
    status: "ACTIVE",
    client_id: null,
    ...partial,
  };
}

function fakeSmartlead(options: {
  campaigns: SmartleadCampaign[];
  clients?: SmartleadClientRecord[];
  analyticsByDate?: Record<number, unknown>;
  analytics?: Record<number, unknown>;
  detail?: Record<number, unknown>;
}) {
  return {
    listCampaigns: async () => options.campaigns,
    listClients: async () => options.clients ?? [],
    getCampaign: async (id: number) => options.detail?.[id] ?? options.campaigns.find((row) => row.id === id),
    getCampaignSettings: async () => ({
      scheduler_cron_value: {
        tz: "America/Chicago",
        days: [1, 2, 3, 4],
        startHour: "09:00",
        endHour: "17:00",
      },
    }),
    getCampaignAnalytics: async (id: number) => options.analytics?.[id] ?? null,
    getCampaignStatistics: async () => null,
    getCampaignAnalyticsByDate: async (id: number) => {
      if (options.analyticsByDate && id in options.analyticsByDate) {
        return options.analyticsByDate[id];
      }
      throw new Error(`no by-date for ${id}`);
    },
    getCampaignEmailAccounts: async () => [
      { id: 1, from_email: "a@x.com", is_smtp_success: true, is_imap_success: true, daily_sent_count: 0 },
    ],
  };
}

function fakeSlack() {
  const posted: string[] = [];
  return {
    posted,
    post: async (text: string) => {
      posted.push(text);
    },
  };
}

function fakeSupabase(options?: {
  campaigns?: Map<number, CampaignNameRow>;
  registry?: Map<number, string>;
}) {
  return {
    enabled: () => true,
    fetchCampaignNames: async () => options?.campaigns ?? new Map(),
    fetchClientRegistry: async () => options?.registry ?? new Map(),
    hasAlert: async () => false,
    markAlert: async () => undefined,
    readSlackTokens: async () => null,
    writeSlackTokens: async () => undefined,
  };
}

async function withService(
  smartlead: ReturnType<typeof fakeSmartlead>,
  slack: ReturnType<typeof fakeSlack>,
  supabase: ReturnType<typeof fakeSupabase>,
  run: (watch: WatchService, state: StateStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-"));
  const state = new StateStore(path.join(dir, "state.json"));
  const config = loadConfig({
    SMARTLEAD_API_KEY: "sl-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    SEND_SHORTFALL_TIMEZONE: "America/Chicago",
  } as NodeJS.ProcessEnv);
  const watch = new WatchService(
    config,
    smartlead as never,
    slack as never,
    state,
    supabase as never,
  );
  try {
    await run(watch, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const lifetimeBcpUnder = {
  total_count: "5328",
  sent_count: "5328",
  unique_sent_count: "5328",
  campaign_lead_stats: { total: 5328, notStarted: 0, inprogress: 5328 },
};
const lifetimeBcpOver = {
  total_count: "620",
  sent_count: "620",
  unique_sent_count: "620",
  campaign_lead_stats: { total: 620, notStarted: 0, inprogress: 620 },
};

describe("resolveClientName", () => {
  it("prefers Smartlead client_id over a stale campaignintelligence name", () => {
    const name = resolveClientName(
      { id: 3815484, name: "Vasco - Signal - Warranty Admin Hiring", status: "ACTIVE", client_id: 1 },
      new Map([[1, { id: 1, name: "Someone Else" }]]),
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
    assert.equal(name, "Someone Else");
  });

  it("falls back to Smartlead client + registry", () => {
    const name = resolveClientName(
      { id: 1, name: "BCP PE Firms (No Team)", status: "PAUSED", client_id: BCP },
      new Map([[BCP, { id: BCP, name: "BCP" }]]),
      new Map(),
      new Map([[BCP, "Bolder Cyber Partners"]]),
    );
    assert.equal(name, "Bolder Cyber Partners");
  });
});

describe("WatchService attribution and flags", () => {
  it("digest/pulse BCP totals stay 0 when today is 0 and lifetime sent is large", async () => {
    const slack = fakeSlack();
    const campaigns = [
      campaign({
        id: 100,
        name: "BCP Healthcare Under-1k (No Team)",
        client_id: BCP,
      }),
      campaign({
        id: 101,
        name: "BCP Healthcare Over-1k (With Team)",
        client_id: BCP,
      }),
      campaign({
        id: 200,
        name: "Culture Fits Sports Offer - copy",
        client_id: 777,
      }),
    ];
    await withService(
      fakeSmartlead({
        campaigns,
        clients: [
          { id: BCP, name: "BCP", logo: "Bolder Cyber Partners" },
          { id: 777, name: "Culture Fits" },
        ],
        analytics: {
          100: lifetimeBcpUnder,
          101: lifetimeBcpOver,
          200: {
            total_count: "5315",
            sent_count: "5315",
            unique_sent_count: "5315",
            campaign_lead_stats: { total: 5315, notStarted: 0, inprogress: 200 },
          },
        },
        analyticsByDate: {
          100: { sent_count: 5328, data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }] },
          101: { sent_count: 620, data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }] },
          200: { sent_count: 12, bounce_count: 0 },
        },
      }),
      slack,
      fakeSupabase({
        campaigns: new Map([
          [
            200,
            {
              smartlead_campaign_id: 200,
              name: "Culture Fits Sports Offer - copy",
              client_name: "Bolder Cyber Partners",
              smartlead_client_id: BCP,
            },
          ],
        ]),
        registry: new Map([[BCP, "Bolder Cyber Partners"]]),
      }),
      async (watch, state) => {
        for (const id of [100, 101, 200]) {
          state.put(id, {
            status: "ACTIVE",
            notifiedThresholds: [50],
            seen: true,
          });
        }
        // Tue 9/1 6:02pm CT — same moment as the bad digest
        const now = new Date("2026-09-01T23:02:00.000Z");
        await watch.run(now);
        const digest = slack.posted.find((text) => text.includes("sent today"));
        assert.ok(digest, "expected a daily digest");
        assert.match(digest, /\*Bolder Cyber Partners\* — 0 sent/);
        assert.doesNotMatch(digest, /\*Bolder Cyber Partners\* — 5,948 sent/);
        assert.match(digest, /\*Culture Fits\* — 12 sent/);
        assert.doesNotMatch(digest, /Healthcare Under-1k \(No Team\) — 5,328 sent/);
      },
    );
  });

  it("posts a 2-hour pulse for the Chicago slot that fired, even if drained late", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
        ],
        clients: [{ id: BCP, logo: "Bolder Cyber Partners" }],
        analyticsByDate: {
          100: { sent_count: 0, bounce_count: 0 },
        },
        analytics: { 100: lifetimeBcpUnder },
      }),
      slack,
      fakeSupabase({ registry: new Map([[BCP, "Bolder Cyber Partners"]]) }),
      async (watch) => {
        // Cron fired 10:05 CT; watch drained at 10:40 CT
        const firedAt = new Date("2026-09-01T15:05:00.000Z");
        const result = await watch.runPulse(firedAt);
        assert.equal(result.posted, true);
        assert.match(slack.posted[0] ?? "", /Tue 9\/1 10:00am — sent today/);
        assert.match(slack.posted[0] ?? "", /\*Bolder Cyber Partners\* — 0 sent/);
        assert.doesNotMatch(slack.posted[0] ?? "", /5,328 sent/);
      },
    );
  });

  it("Slacks nearly-done and finished after hours instead of eating the flag", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({
            id: 50,
            name: "Vasco - Signal - Warranty Admin Hiring",
            client_id: 548609,
          }),
        ],
        clients: [{ id: 548609, name: "Vasco Warranty" }],
        analytics: {
          50: {
            total_count: "1000",
            unique_sent_count: "900",
            campaign_lead_stats: { total: 1000, notStarted: 40, inprogress: 60 },
          },
        },
        analyticsByDate: { 50: { sent_count: 20, bounce_count: 0 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[548609, "Vasco Warranty"]]) }),
      async (watch, state) => {
        state.put(50, { status: "ACTIVE", notifiedThresholds: [50], seen: true });
        // 6:02pm CT — previously dropped 75/90 because afterHours
        const result = await watch.run(new Date("2026-09-01T23:02:00.000Z"));
        assert.equal(result.completion, 2);
        assert.equal(
          slack.posted.filter((text) => text.includes("nearly done (75%")).length,
          1,
        );
        assert.equal(
          slack.posted.filter((text) => text.includes("nearly done (90%")).length,
          1,
        );
        assert.match(slack.posted.join("\n"), /100 left\)\. Refill soon/);
        assert.ok(state.snapshot(50).notifiedThresholds.includes(75));
        assert.ok(state.snapshot(50).notifiedThresholds.includes(90));
      },
    );
  });

  it("posts a finished-list Slack payload when the campaign hits 100%", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({
            id: 51,
            name: "Vasco - Service - Standard Brands",
            client_id: 548609,
          }),
        ],
        clients: [{ id: 548609, name: "Vasco Warranty" }],
        analytics: {
          51: {
            total_count: "200",
            unique_sent_count: "200",
            campaign_lead_stats: { total: 200, notStarted: 0, inprogress: 0 },
          },
        },
        analyticsByDate: { 51: { sent_count: 4, bounce_count: 0 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[548609, "Vasco Warranty"]]) }),
      async (watch, state) => {
        state.put(51, { status: "ACTIVE", notifiedThresholds: [50, 75, 90], seen: true });
        const result = await watch.run(new Date("2026-09-01T16:10:00.000Z"));
        assert.equal(result.completion, 1);
        assert.equal(
          slack.posted[0],
          "*Vasco Warranty* — *Vasco - Service - Standard Brands* finished the list. This client now has nothing sending — flag for a lead refill.",
        );
      },
    );
  });
});
