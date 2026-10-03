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
  settings?: Record<number, unknown>;
  emailAccounts?: Record<
    number,
    Array<{
      id: number;
      from_email?: string;
      is_smtp_success?: boolean;
      is_imap_success?: boolean;
      daily_sent_count?: number;
    }>
  >;
}) {
  const defaultInbox = [
    { id: 1, from_email: "a@x.com", is_smtp_success: true, is_imap_success: true, daily_sent_count: 0 },
  ];
  return {
    listCampaigns: async () => options.campaigns,
    listClients: async () => options.clients ?? [],
    getCampaign: async (id: number) => options.detail?.[id] ?? options.campaigns.find((row) => row.id === id),
    getCampaignSettings: async (id: number) =>
      options.settings?.[id] ?? {
        scheduler_cron_value: {
          tz: "America/Chicago",
          days: [1, 2, 3, 4, 5],
          startHour: "09:00",
          endHour: "18:00",
        },
      },
    getCampaignAnalytics: async (id: number) => options.analytics?.[id] ?? null,
    getCampaignStatistics: async () => null,
    getCampaignAnalyticsByDate: async (id: number) => {
      if (options.analyticsByDate && id in options.analyticsByDate) {
        return options.analyticsByDate[id];
      }
      throw new Error(`no by-date for ${id}`);
    },
    getCampaignEmailAccounts: async (id: number) => options.emailAccounts?.[id] ?? defaultInbox,
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

const noonTue = new Date("2026-09-01T17:10:00.000Z"); // 12:10pm CT
const eodTue = new Date("2026-09-01T22:30:00.000Z"); // 5:30pm CT
const noonSat = new Date("2026-09-05T17:10:00.000Z");
const weekdayAfternoon = new Date("2026-09-01T16:10:00.000Z");

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

describe("WatchService Slack — midday / autobounce / EOD only", () => {
  it("posts a compact midday line per active client and flags under 1,080 projected", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
          campaign({ id: 200, name: "Vasco - Signal", client_id: 548609 }),
          campaign({ id: 12, name: "BCP Generic (No Team)", status: "PAUSED", client_id: BCP }),
          campaign({ id: 3628943, name: "Positive", client_id: null }),
        ],
        clients: [
          { id: BCP, logo: "Bolder Cyber Partners" },
          { id: 548609, name: "Vasco Warranty" },
        ],
        analyticsByDate: {
          100: { sent_count: 400, data: [{ date: "2026-09-01", sent_count: 400 }] },
          200: { sent_count: 200, data: [{ date: "2026-09-01", sent_count: 200 }] },
          12: { sent_count: 50, data: [{ date: "2026-09-01", sent_count: 50 }] },
          3628943: { sent_count: 10, data: [{ date: "2026-09-01", sent_count: 10 }] },
        },
      }),
      slack,
      fakeSupabase({
        registry: new Map([
          [BCP, "Bolder Cyber Partners"],
          [548609, "Vasco Warranty"],
        ]),
      }),
      async (watch) => {
        const result = await watch.runVolumeCheck(noonTue);
        assert.equal(result.posted, true);
        assert.equal(result.clients, 2);
        const text = slack.posted[0] ?? "";
        assert.match(text, /\*Midday — Tue 9\/1 12:00pm\*/);
        // 9–18 at noon is ×3: 400→1,200 on track; 200→600 under
        assert.match(
          text,
          /• \*Bolder Cyber Partners\* `#542838` — 400 sent → 1,200 proj · on track/,
        );
        assert.match(text, /• \*Vasco Warranty\* `#548609` — 200 sent → 600 proj · \*under\*/);
        assert.doesNotMatch(text, /Off track/i);
        assert.doesNotMatch(text, /Positive/);
        assert.doesNotMatch(text, /Generic/);
        assert.doesNotMatch(text, /Paused:/);
      },
    );
  });

  it("does not post midday on Saturday and does not catch up", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [campaign({ id: 100, name: "BCP Healthcare", client_id: BCP })],
        clients: [{ id: BCP, logo: "Bolder Cyber Partners" }],
        analyticsByDate: { 100: { sent_count: 0, bounce_count: 0 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[BCP, "Bolder Cyber Partners"]]) }),
      async (watch) => {
        const result = await watch.runVolumeCheck(noonSat);
        assert.equal(result.posted, false);
        assert.equal(slack.posted.length, 0);
      },
    );
  });

  it("keeps midday BCP totals on today's analytics-by-date, not lifetime sent", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
          campaign({
            id: 200,
            name: "Culture Fits Sports Offer - copy",
            client_id: 777,
          }),
        ],
        clients: [
          { id: BCP, logo: "Bolder Cyber Partners" },
          { id: 777, name: "Culture Fits" },
        ],
        analytics: {
          100: { sent_count: "5328", campaign_lead_stats: { total: 5328, notStarted: 0, inprogress: 5328 } },
        },
        analyticsByDate: {
          100: { sent_count: 5328, data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }] },
          200: { sent_count: 400, data: [{ date: "2026-09-01", sent_count: 400 }] },
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
      async (watch) => {
        await watch.runVolumeCheck(noonTue);
        const text = slack.posted[0] ?? "";
        assert.match(text, /\*Bolder Cyber Partners\* `#542838` — 0 sent → 0 proj · \*under\*/);
        assert.match(text, /\*Culture Fits\* `#777` — 400 sent → 1,200 proj · on track/);
        assert.doesNotMatch(text, /5,328/);
      },
    );
  });

  it("posts EOD sends vs 1,200 and flags a client with less than 7 days left", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare", client_id: BCP }),
          campaign({ id: 200, name: "Vasco - Signal", client_id: 548609 }),
        ],
        clients: [
          { id: BCP, logo: "Bolder Cyber Partners" },
          { id: 548609, name: "Vasco Warranty" },
        ],
        analytics: {
          100: {
            total_count: "20000",
            campaign_lead_stats: { total: 20000, notStarted: 15000, inprogress: 5000 },
          },
          200: {
            total_count: "6000",
            campaign_lead_stats: { total: 6000, notStarted: 4000, inprogress: 1000 },
          },
        },
        analyticsByDate: {
          100: { data: [{ date: "2026-09-01", sent_count: 1180 }] },
          200: { data: [{ date: "2026-09-01", sent_count: 720 }] },
        },
      }),
      slack,
      fakeSupabase({
        registry: new Map([
          [BCP, "Bolder Cyber Partners"],
          [548609, "Vasco Warranty"],
        ]),
      }),
      async (watch) => {
        const result = await watch.runEndOfDay(eodTue);
        assert.equal(result.posted, true);
        assert.equal(result.topUp, 1);
        const text = slack.posted[0] ?? "";
        assert.match(text, /\*EOD — Tue 9\/1\*/);
        assert.match(text, /• \*Bolder Cyber Partners\* `#542838` — 1,180 \/ 1,200/);
        assert.match(
          text,
          /• \*Vasco Warranty\* `#548609` — 720 \/ 1,200 · \*under\* · \*~4\.2d left, needs top-up\*/,
        );
        assert.doesNotMatch(text, /Off track/i);
        assert.doesNotMatch(text, /Still waiting/);
        assert.doesNotMatch(text, /Finished today/);
      },
    );
  });

  it("does not post EOD on Saturday", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [campaign({ id: 100, name: "BCP Healthcare", client_id: BCP })],
        analyticsByDate: { 100: { sent_count: 10 } },
      }),
      slack,
      fakeSupabase(),
      async (watch) => {
        const result = await watch.runEndOfDay(new Date("2026-09-05T22:30:00.000Z"));
        assert.equal(result.posted, false);
        assert.equal(slack.posted.length, 0);
      },
    );
  });

  it("Slacks an autobounce pause immediately with client, campaign id, and reason", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({
            id: 88,
            name: "Goliath Displacement S 50-200 CIO",
            status: "PAUSED",
            client_id: 9,
          }),
        ],
        clients: [{ id: 9, name: "Goliath Cybersecurity" }],
        analytics: {
          88: { sent_count: 195, bounce_count: 16, bounce_rate: 8.2 },
        },
        detail: {
          88: {
            id: 88,
            name: "Goliath Displacement S 50-200 CIO",
            status: "PAUSED",
            client_id: 9,
            auto_paused: true,
          },
        },
      }),
      slack,
      fakeSupabase({ registry: new Map([[9, "Goliath Cybersecurity"]]) }),
      async (watch, state) => {
        state.put(88, { status: "ACTIVE", notifiedThresholds: [], seen: true });
        const result = await watch.run(weekdayAfternoon);
        assert.equal(result.autobounce, 1);
        assert.equal(result.completion, 0);
        assert.equal(result.digest, 0);
        assert.equal(result.heyreach, 0);
        assert.equal(slack.posted.length, 1);
        assert.match(
          slack.posted[0] ?? "",
          /\*Goliath Cybersecurity\* — \*Goliath Displacement S 50-200 CIO\* `#88` auto-paused/,
        );
        assert.match(slack.posted[0] ?? "", /8\.2% bounce on 195 sends/);
      },
    );
  });

  it("does not Slack a manual pause", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({
            id: 88,
            name: "Goliath Displacement",
            status: "PAUSED",
            client_id: 9,
          }),
        ],
        clients: [{ id: 9, name: "Goliath Cybersecurity" }],
        analytics: { 88: { sent_count: 400, bounce_count: 4, bounce_rate: 1 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[9, "Goliath Cybersecurity"]]) }),
      async (watch, state) => {
        state.put(88, { status: "ACTIVE", notifiedThresholds: [], seen: true });
        const weekday = await watch.run(weekdayAfternoon);
        assert.equal(weekday.autobounce, 0);
        assert.equal(slack.posted.length, 0);
      },
    );
  });

  it("does not Slack an autobounce on Saturday (no weekend catch-up)", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({
            id: 88,
            name: "Goliath Displacement",
            status: "PAUSED",
            client_id: 9,
          }),
        ],
        clients: [{ id: 9, name: "Goliath Cybersecurity" }],
        analytics: { 88: { sent_count: 195, bounce_count: 16, bounce_rate: 8.2 } },
        detail: {
          88: { id: 88, status: "PAUSED", client_id: 9, auto_paused: true },
        },
      }),
      slack,
      fakeSupabase({ registry: new Map([[9, "Goliath Cybersecurity"]]) }),
      async (watch, state) => {
        state.put(88, { status: "ACTIVE", notifiedThresholds: [], seen: true });
        const result = await watch.run(new Date("2026-09-05T16:10:00.000Z"));
        assert.equal(result.autobounce, 0);
        assert.equal(slack.posted.length, 0);
        assert.equal(state.snapshot(88).status, "PAUSED");
      },
    );
  });

  it("does not Slack completion, digest, pulse Off track, or HeyReach from the 15-minute watch", async () => {
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
        const result = await watch.run(new Date("2026-09-01T23:02:00.000Z"));
        assert.equal(result.completion, 0);
        assert.equal(result.digest, 0);
        assert.equal(result.heyreach, 0);
        assert.equal(slack.posted.length, 0);
      },
    );
  });
});
