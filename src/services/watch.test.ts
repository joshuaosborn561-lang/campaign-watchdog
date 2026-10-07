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
  const started: Array<{ id: number; status: string }> = [];
  const defaultInbox = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    from_email: `s${i}@x.com`,
    is_smtp_success: true,
    is_imap_success: true,
    daily_sent_count: 0,
  }));
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
    updateCampaignStatus: async (id: number, status: "START" | "PAUSED" | "STOPPED") => {
      started.push({ id, status });
      const row = options.campaigns.find((campaign) => campaign.id === id);
      if (row && status === "START") row.status = "ACTIVE";
      return { ok: true, status };
    },
    started,
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
  bounceHoldIds?: Iterable<number>;
}) {
  return {
    enabled: () => true,
    fetchCampaignNames: async () => options?.campaigns ?? new Map(),
    fetchClientRegistry: async () => options?.registry ?? new Map(),
    fetchBounceHoldCampaignIds: async () => new Set(options?.bounceHoldIds ?? []),
    hasAlert: async () => false,
    markAlert: async () => undefined,
    readSlackTokens: async () => null,
    writeSlackTokens: async () => undefined,
  };
}

function fakeHeyReach(options: {
  workspace: { id: string; clientName: string };
  campaigns: Array<{
    id: number;
    name: string;
    status?: string;
    pending: number;
    inProgress: number;
    total?: number;
  }>;
  byDayStats?: Record<number, unknown>;
}) {
  return {
    workspace: { ...options.workspace, apiKey: "test" },
    listCampaigns: async () =>
      options.campaigns.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status ?? "IN_PROGRESS",
        progressStats: {
          total: row.total ?? row.pending + row.inProgress,
          pending: row.pending,
          inProgress: row.inProgress,
          finished: 0,
          failed: 0,
        },
      })),
    getCampaign: async () => null,
    getOverallStats: async (input: { campaignId: number }) =>
      options.byDayStats?.[input.campaignId] ?? { byDayStats: {} },
  };
}

async function withService(
  smartlead: ReturnType<typeof fakeSmartlead>,
  slack: ReturnType<typeof fakeSlack>,
  supabase: ReturnType<typeof fakeSupabase>,
  run: (watch: WatchService, state: StateStore) => Promise<void>,
  heyreach: ReturnType<typeof fakeHeyReach>[] = [],
  env: Record<string, string> = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "watchdog-"));
  const state = new StateStore(path.join(dir, "state.json"));
  const config = loadConfig({
    SMARTLEAD_API_KEY: "sl-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    SEND_SHORTFALL_TIMEZONE: "America/Chicago",
    ...env,
  } as NodeJS.ProcessEnv);
  const watch = new WatchService(
    config,
    smartlead as never,
    slack as never,
    state,
    supabase as never,
    heyreach as never,
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

describe("WatchService Slack — pulse / midday / autobounce / EOD", () => {
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
        assert.match(
          text,
          /• \*Vasco Warranty\* `#548609` — 200 sent → 600 proj · \*under\* — pace short of 1,200/,
        );
        assert.doesNotMatch(text, /Off track/i);
        assert.doesNotMatch(text, /low on leads/);
        assert.doesNotMatch(text, /needs top-up/);
        assert.doesNotMatch(text, /Positive/);
        assert.doesNotMatch(text, /Generic/);
        assert.doesNotMatch(text, /Paused:/);
      },
    );
  });

  it("posts a weekday 2-hour sent-today pulse without Off track or low-leads", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
          campaign({ id: 200, name: "Vasco - Signal", client_id: 548609 }),
          campaign({
            id: 12,
            name: "BCP Generic (No Team)",
            status: "PAUSED",
            client_id: BCP,
          }),
          campaign({ id: 3628943, name: "Positive", status: "PAUSED", client_id: null }),
          campaign({
            id: 11,
            name: "MSRS Ticket Offer Propert Manager",
            status: "PAUSED",
            client_id: null,
          }),
        ],
        clients: [
          { id: BCP, logo: "Bolder Cyber Partners" },
          { id: 548609, name: "Vasco Warranty" },
        ],
        analyticsByDate: {
          100: { sent_count: 400, data: [{ date: "2026-09-01", sent_count: 400, bounce_count: 2 }] },
          200: { sent_count: 200, data: [{ date: "2026-09-01", sent_count: 200, bounce_count: 0 }] },
          12: { sent_count: 0, bounce_count: 0 },
          3628943: { sent_count: 10, bounce_count: 0 },
          11: { sent_count: 0, bounce_count: 0 },
        },
        analytics: {
          100: { campaign_lead_stats: { total: 12, notStarted: 0, inprogress: 0 } },
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
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.posted, true);
        const text = slack.posted[0] ?? "";
        assert.match(text, /Tue 9\/1 10:00am — sent today/);
        assert.match(text, /\*Bolder Cyber Partners\* — 400 sent/);
        assert.match(text, /\*Vasco Warranty\* — 200 sent/);
        assert.match(text, /Paused: 1 \(new pauses still alert via 15m watch\)/);
        assert.doesNotMatch(text, /Off track/i);
        assert.doesNotMatch(text, /too few leads/);
        assert.doesNotMatch(text, /low on leads/);
        assert.doesNotMatch(text, /Positive/);
        assert.doesNotMatch(text, /Propert Manager/);
        assert.doesNotMatch(text, /Generic \(No Team\)/);
        assert.doesNotMatch(text, /Healthcare Under-1k/);
        assert.doesNotMatch(text, /<@/);
      },
    );
  });

  it("mentions Cayden and Josh on the pulse when any client is *under*", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
          campaign({ id: 200, name: "Vasco - Signal", client_id: 548609 }),
        ],
        clients: [
          { id: BCP, logo: "Bolder Cyber Partners" },
          { id: 548609, name: "Vasco Warranty" },
        ],
        analyticsByDate: {
          100: { data: [{ date: "2026-09-01", sent_count: 400, bounce_count: 0 }] },
          200: { data: [{ date: "2026-09-01", sent_count: 80, bounce_count: 0 }] },
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
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.posted, true);
        assert.equal(result.under, 1);
        const text = slack.posted[0] ?? "";
        assert.equal(text.split("\n")[0], "<@U0BL8JT75KN> <@U0AAX2XFJE7>");
        assert.match(
          text,
          /\*Vasco Warranty\* — 80 sent · 0\.0% bounce · \*under\* — pace short of 1,200/,
        );
        assert.match(text, /\*Bolder Cyber Partners\* — 400 sent/);
        assert.doesNotMatch(text, /too few leads/);
        assert.doesNotMatch(text, /Off track/i);
      },
    );
  });

  it("explains pulse *under* from remaining leads without dumping campaigns", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [
          campaign({ id: 200, name: "SalesGlider Nurture", client_id: 345263 }),
        ],
        clients: [{ id: 345263, name: "SalesGlider" }],
        analyticsByDate: {
          200: { data: [{ date: "2026-09-01", sent_count: 80, bounce_count: 0 }] },
        },
        analytics: {
          200: {
            total_count: "90",
            campaign_lead_stats: { total: 90, notStarted: 5, inprogress: 5 },
          },
        },
      }),
      slack,
      fakeSupabase({ registry: new Map([[345263, "SalesGlider"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.posted, true);
        assert.equal(result.under, 1);
        const text = slack.posted[0] ?? "";
        assert.match(
          text,
          /\*SalesGlider\* — 80 sent · 0\.0% bounce · \*under\* — too few leads on ACTIVE lists/,
        );
        assert.doesNotMatch(text, /Nurture/);
        assert.doesNotMatch(text, /Off track/i);
      },
    );
  });

  it("explains midday *under* from too few linked inboxes", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [campaign({ id: 300, name: "PowerGRYD Owners", client_id: 592842 })],
        clients: [{ id: 592842, name: "PowerGRYD" }],
        analyticsByDate: {
          300: { data: [{ date: "2026-09-01", sent_count: 97 }] },
        },
        analytics: {
          300: {
            total_count: "20000",
            campaign_lead_stats: { total: 20000, notStarted: 15000, inprogress: 2000 },
          },
        },
        emailAccounts: {
          300: Array.from({ length: 20 }, (_, i) => ({
            id: i + 1,
            from_email: `p${i}@x.com`,
            is_smtp_success: true,
            is_imap_success: true,
            daily_sent_count: 2,
          })),
        },
      }),
      slack,
      fakeSupabase({ registry: new Map([[592842, "PowerGRYD"]]) }),
      async (watch) => {
        const result = await watch.runVolumeCheck(noonTue);
        assert.equal(result.posted, true);
        const text = slack.posted[0] ?? "";
        assert.match(
          text,
          /• \*PowerGRYD\* `#592842` — 97 sent → 291 proj · \*under\* — only ~20 campaign inboxes linked/,
        );
        assert.doesNotMatch(text, /Owners/);
      },
    );
  });

  it("does not flag *under* or mention anyone on the 8am pulse before windows start", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [campaign({ id: 200, name: "Vasco - Signal", client_id: 548609 })],
        clients: [{ id: 548609, name: "Vasco Warranty" }],
        analyticsByDate: {
          200: { data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }] },
        },
      }),
      slack,
      fakeSupabase({ registry: new Map([[548609, "Vasco Warranty"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-01T13:05:00.000Z"));
        assert.equal(result.posted, true);
        assert.equal(result.under, 0);
        const text = slack.posted[0] ?? "";
        assert.match(text, /Tue 9\/1 8:00am — sent today/);
        assert.match(text, /\*Vasco Warranty\* — 0 sent$/m);
        assert.doesNotMatch(text, /\*under\*/);
        assert.doesNotMatch(text, /<@/);
        assert.doesNotMatch(text, /too few leads/);
      },
    );
  });

  it("does not post a weekend pulse and does not catch up", async () => {
    const slack = fakeSlack();
    await withService(
      fakeSmartlead({
        campaigns: [campaign({ id: 100, name: "BCP Healthcare", client_id: BCP })],
        clients: [{ id: BCP, logo: "Bolder Cyber Partners" }],
        analyticsByDate: { 100: { sent_count: 10 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[BCP, "Bolder Cyber Partners"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-05T15:05:00.000Z"));
        assert.equal(result.posted, false);
        assert.equal(slack.posted.length, 0);
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
        assert.match(
          text,
          /\*Bolder Cyber Partners\* `#542838` — 0 sent → 0 proj · \*under\* — pace short of 1,200/,
        );
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
          /• \*Vasco Warranty\* `#548609` — 720 \/ 1,200 · \*under\* — pace short of 1,200/,
        );
        assert.match(text, /• \*Vasco Warranty\* — 1 low on leads/);
        assert.doesNotMatch(text, /Signal/);
        assert.doesNotMatch(text, /Bolder Cyber Partners\* — \d+ low on leads/);
        assert.doesNotMatch(text, /needs top-up/);
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

  it("does not Slack a digest or Off track pulse from the 15-minute watch", async () => {
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
            total_count: "200",
            unique_sent_count: "20",
            campaign_lead_stats: { total: 200, notStarted: 160, inprogress: 20 },
          },
        },
        analyticsByDate: { 50: { sent_count: 20, bounce_count: 0 } },
      }),
      slack,
      fakeSupabase({ registry: new Map([[548609, "Vasco Warranty"]]) }),
      async (watch, state) => {
        state.put(50, { status: "ACTIVE", notifiedThresholds: [50], seen: true });
        const result = await watch.run(new Date("2026-09-01T23:02:00.000Z"));
        assert.equal(result.digest, 0);
        assert.doesNotMatch(slack.posted.join("\n"), /sent today/);
        assert.doesNotMatch(slack.posted.join("\n"), /Off track/i);
        assert.doesNotMatch(slack.posted.join("\n"), /Still waiting/);
      },
    );
  });

  it("Slacks nearly-done and finished on a weekday, including after hours", async () => {
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

  it("posts a finished-list Slack when the campaign hits 100%", async () => {
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
        const result = await watch.run(weekdayAfternoon);
        assert.equal(result.completion, 1);
        assert.equal(
          slack.posted[0],
          "*Vasco Warranty* — *Vasco - Service - Standard Brands* finished the list. This client now has nothing sending — flag for a lead refill.",
        );
      },
    );
  });

  it("does not Slack completion on Saturday and does not catch up Monday", async () => {
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
      }),
      slack,
      fakeSupabase({ registry: new Map([[548609, "Vasco Warranty"]]) }),
      async (watch, state) => {
        state.put(50, { status: "ACTIVE", notifiedThresholds: [50], seen: true });
        const sat = await watch.run(new Date("2026-09-05T16:10:00.000Z"));
        assert.equal(sat.completion, 0);
        assert.equal(slack.posted.length, 0);
        assert.ok(state.snapshot(50).notifiedThresholds.includes(75));
        assert.ok(state.snapshot(50).notifiedThresholds.includes(90));

        const mon = await watch.run(new Date("2026-09-07T16:10:00.000Z"));
        assert.equal(mon.completion, 0);
        assert.equal(slack.posted.length, 0);
      },
    );
  });
});

const weekdayPace = {
  byDayStats: {
    "2026-08-24": { connectionsSent: 2, messagesSent: 1 },
    "2026-08-25": { connectionsSent: 2, messagesSent: 2 },
    "2026-08-26": { connectionsSent: 1, messagesSent: 2 },
    "2026-08-27": { connectionsSent: 2, messagesSent: 1 },
    "2026-08-28": { connectionsSent: 3, messagesSent: 2 },
  },
};

describe("WatchService HeyReach runway", () => {
  it("seeds first seen under-7/dry without Slack, then pages client + campaign", async () => {
    const slack = fakeSlack();
    const heyreach = fakeHeyReach({
      workspace: { id: "techevo", clientName: "TechEvolution" },
      campaigns: [
        { id: 566902, name: "TechEvo NE IT DM v2", pending: 0, inProgress: 21, total: 45 },
      ],
      byDayStats: { 566902: weekdayPace },
    });
    await withService(
      fakeSmartlead({ campaigns: [] }),
      slack,
      fakeSupabase(),
      async (watch, state) => {
        const now = weekdayAfternoon;
        const first = await watch.run(now);
        assert.equal(first.heyreach, 0);
        assert.equal(slack.posted.length, 0);
        assert.equal(state.heyreachSnapshot("techevo", 566902).seen, true);
        assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedUnder7, true);

        state.putHeyreach("techevo", 566902, {
          status: "IN_PROGRESS",
          seen: true,
          notifiedUnder7: false,
          notifiedPendingDry: false,
        });
        const second = await watch.run(now);
        assert.equal(second.heyreach, 1);
        assert.equal(
          slack.posted[0],
          "*TechEvolution* — *TechEvo NE IT DM v2* is nearly done (~5.8d LinkedIn runway, 21 left, 0 pending). Refill soon.",
        );
      },
      [heyreach],
    );
  });

  it("does not Slack Call Followups 530529 even when pending-dry", async () => {
    const slack = fakeSlack();
    const heyreach = fakeHeyReach({
      workspace: { id: "salesglider", clientName: "SalesGlider" },
      campaigns: [
        { id: 530529, name: "Call Followups", pending: 0, inProgress: 7, total: 13 },
        { id: 557698, name: "Staffing Owners v2", pending: 305, inProgress: 122, total: 522 },
      ],
      byDayStats: {
        530529: weekdayPace,
        557698: {
          byDayStats: {
            "2026-08-24": { connectionsSent: 20, messagesSent: 2 },
            "2026-08-25": { connectionsSent: 20, messagesSent: 2 },
            "2026-08-26": { connectionsSent: 20, messagesSent: 2 },
            "2026-08-27": { connectionsSent: 20, messagesSent: 2 },
            "2026-08-28": { connectionsSent: 20, messagesSent: 2 },
          },
        },
      },
    });
    await withService(
      fakeSmartlead({ campaigns: [] }),
      slack,
      fakeSupabase(),
      async (watch, state) => {
        const now = weekdayAfternoon;
        await watch.run(now);
        state.putHeyreach("salesglider", 530529, {
          status: "IN_PROGRESS",
          seen: true,
          notifiedUnder7: false,
          notifiedPendingDry: false,
        });
        state.putHeyreach("salesglider", 557698, {
          status: "IN_PROGRESS",
          seen: true,
          notifiedUnder7: false,
          notifiedPendingDry: false,
        });
        const result = await watch.run(now);
        assert.equal(result.heyreach, 0);
        assert.equal(slack.posted.length, 0);
      },
      [heyreach],
    );
  });

  it("skips Slack when supabase already has the under-7 key", async () => {
    const slack = fakeSlack();
    const heyreach = fakeHeyReach({
      workspace: { id: "techevo", clientName: "TechEvolution" },
      campaigns: [
        { id: 566902, name: "TechEvo NE IT DM v2", pending: 0, inProgress: 21, total: 45 },
      ],
      byDayStats: { 566902: weekdayPace },
    });
    const sent = new Set(["heyreach:under7:v1:566902", "heyreach:pending-dry:v1:566902"]);
    await withService(
      fakeSmartlead({ campaigns: [] }),
      slack,
      {
        ...fakeSupabase(),
        hasAlert: async (key: string) => sent.has(key),
      },
      async (watch, state) => {
        state.putHeyreach("techevo", 566902, {
          status: "IN_PROGRESS",
          seen: true,
          notifiedUnder7: false,
          notifiedPendingDry: false,
        });
        const result = await watch.run(weekdayAfternoon);
        assert.equal(result.heyreach, 0);
        assert.equal(slack.posted.length, 0);
      },
      [heyreach],
    );
  });
});

describe("WatchService Slack — bounce-hold auto-resume", () => {
  const remaining = {
    total_count: "2000",
    campaign_lead_stats: { total: 2000, notStarted: 800, inprogress: 200 },
  };

  it("STARTs a Watchdog-stamped bounce hold and adds Unpaused N bounce holds", async () => {
    const slack = fakeSlack();
    const smartlead = fakeSmartlead({
      campaigns: [
        campaign({ id: 100, name: "BCP Healthcare Under-1k (No Team)", client_id: BCP }),
        campaign({
          id: 88,
          name: "BCP Displacement Hold",
          status: "PAUSED",
          client_id: BCP,
        }),
      ],
      clients: [{ id: BCP, logo: "Bolder Cyber Partners" }],
      analyticsByDate: {
        100: { data: [{ date: "2026-09-01", sent_count: 400, bounce_count: 0 }] },
        88: { data: [{ date: "2026-09-01", sent_count: 0, bounce_count: 0 }] },
      },
      analytics: { 88: remaining, 100: remaining },
    });
    await withService(
      smartlead,
      slack,
      fakeSupabase({ registry: new Map([[BCP, "Bolder Cyber Partners"]]) }),
      async (watch, state) => {
        state.put(88, {
          status: "PAUSED",
          notifiedThresholds: [],
          seen: true,
          lastAutobounceAlertAt: "2026-09-01T14:00:00.000Z",
        });
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.unpaused, 1);
        assert.deepEqual(smartlead.started, [{ id: 88, status: "START" }]);
        assert.match(slack.posted[0] ?? "", /Unpaused 1 bounce holds/);
      },
    );
  });

  it("STARTs a hold whose campaign_activity_logs.paused_reason is bounce protection", async () => {
    const slack = fakeSlack();
    const smartlead = fakeSmartlead({
      campaigns: [
        campaign({
          id: 77,
          name: "Vasco - Signal",
          status: "PAUSED",
          client_id: 548609,
          paused_reason: "operator",
        }),
      ],
      clients: [{ id: 548609, name: "Vasco Warranty" }],
      analyticsByDate: {
        77: { data: [{ date: "2026-09-01", sent_count: 10, bounce_count: 0 }] },
      },
      analytics: { 77: remaining },
    });
    await withService(
      smartlead,
      slack,
      fakeSupabase({
        registry: new Map([[548609, "Vasco Warranty"]]),
        bounceHoldIds: [77],
      }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.unpaused, 1);
        assert.deepEqual(smartlead.started, [{ id: 77, status: "START" }]);
        assert.match(slack.posted[0] ?? "", /Unpaused 1 bounce holds/);
      },
    );
  });

  it("does not START exclude-list IDs, empty lists, no-client shells, or manual pauses", async () => {
    const slack = fakeSlack();
    const smartlead = fakeSmartlead({
      campaigns: [
        campaign({
          id: 3739316,
          name: "Cayden holdout",
          status: "PAUSED",
          client_id: 345263,
          paused_reason: "bounce protection",
        }),
        campaign({
          id: 201,
          name: "No mailboxes",
          status: "PAUSED",
          client_id: BCP,
          paused_reason: "bounce protection",
        }),
        campaign({
          id: 202,
          name: "No leads left",
          status: "PAUSED",
          client_id: BCP,
          paused_reason: "bounce protection",
        }),
        campaign({
          id: 203,
          name: "Untagged leftover",
          status: "PAUSED",
          client_id: null,
          paused_reason: "bounce protection",
        }),
        campaign({
          id: 204,
          name: "Manual pause",
          status: "PAUSED",
          client_id: BCP,
        }),
      ],
      clients: [
        { id: BCP, logo: "Bolder Cyber Partners" },
        { id: 345263, name: "SalesGlider" },
      ],
      analyticsByDate: {
        3739316: { data: [{ date: "2026-09-01", sent_count: 0 }] },
        201: { data: [{ date: "2026-09-01", sent_count: 0 }] },
        202: { data: [{ date: "2026-09-01", sent_count: 0 }] },
        203: { data: [{ date: "2026-09-01", sent_count: 0 }] },
        204: { data: [{ date: "2026-09-01", sent_count: 0 }] },
      },
      analytics: {
        3739316: remaining,
        201: remaining,
        202: {
          total_count: "100",
          campaign_lead_stats: { total: 100, notStarted: 0, inprogress: 0 },
        },
        203: remaining,
        204: remaining,
      },
      emailAccounts: { 201: [] },
    });
    await withService(
      smartlead,
      slack,
      fakeSupabase({
        registry: new Map([
          [BCP, "Bolder Cyber Partners"],
          [345263, "SalesGlider"],
        ]),
      }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.unpaused, 0);
        assert.deepEqual(smartlead.started, []);
        assert.doesNotMatch(slack.posted.join("\n"), /Unpaused/);
      },
    );
  });

  it("skips Goliath 548611 through 2026-10-15 and STARTs after that date", async () => {
    const goliath = campaign({
      id: 55,
      name: "Goliath Displacement S",
      status: "PAUSED",
      client_id: 548611,
      paused_reason: "bounce protection",
    });
    const slackHold = fakeSlack();
    const during = fakeSmartlead({
      campaigns: [goliath],
      clients: [{ id: 548611, name: "Goliath Cybersecurity" }],
      analyticsByDate: {
        55: { data: [{ date: "2026-10-07", sent_count: 0 }] },
      },
      analytics: { 55: remaining },
    });
    await withService(
      during,
      slackHold,
      fakeSupabase({ registry: new Map([[548611, "Goliath Cybersecurity"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-10-07T15:05:00.000Z"));
        assert.equal(result.unpaused, 0);
        assert.deepEqual(during.started, []);
        assert.doesNotMatch(slackHold.posted.join("\n"), /Unpaused/);
      },
    );

    const slackAfter = fakeSlack();
    const after = fakeSmartlead({
      campaigns: [{ ...goliath, status: "PAUSED" }],
      clients: [{ id: 548611, name: "Goliath Cybersecurity" }],
      analyticsByDate: {
        55: { data: [{ date: "2026-10-16", sent_count: 0 }] },
      },
      analytics: { 55: remaining },
    });
    await withService(
      after,
      slackAfter,
      fakeSupabase({ registry: new Map([[548611, "Goliath Cybersecurity"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-10-16T15:05:00.000Z"));
        assert.equal(result.unpaused, 1);
        assert.deepEqual(after.started, [{ id: 55, status: "START" }]);
        assert.match(slackAfter.posted[0] ?? "", /Unpaused 1 bounce holds/);
      },
    );
  });

  it("does not START when AUTO_RESUME_BOUNCE_HOLDS is off", async () => {
    const slack = fakeSlack();
    const smartlead = fakeSmartlead({
      campaigns: [
        campaign({
          id: 88,
          name: "BCP Displacement Hold",
          status: "PAUSED",
          client_id: BCP,
          paused_reason: "bounce protection",
        }),
      ],
      clients: [{ id: BCP, logo: "Bolder Cyber Partners" }],
      analyticsByDate: {
        88: { data: [{ date: "2026-09-01", sent_count: 0 }] },
      },
      analytics: { 88: remaining },
    });
    await withService(
      smartlead,
      slack,
      fakeSupabase({ registry: new Map([[BCP, "Bolder Cyber Partners"]]) }),
      async (watch) => {
        const result = await watch.runPulse(new Date("2026-09-01T15:05:00.000Z"));
        assert.equal(result.unpaused, 0);
        assert.deepEqual(smartlead.started, []);
        assert.doesNotMatch(slack.posted.join("\n"), /Unpaused/);
      },
      [],
      { AUTO_RESUME_BOUNCE_HOLDS: "0" },
    );
  });
});

describe("WatchService HeyReach runway", () => {
  it("does not Slack HeyReach on Saturday and does not catch up Monday", async () => {
    const slack = fakeSlack();
    const heyreach = fakeHeyReach({
      workspace: { id: "techevo", clientName: "TechEvolution" },
      campaigns: [
        { id: 566902, name: "TechEvo NE IT DM v2", pending: 0, inProgress: 21, total: 45 },
      ],
      byDayStats: { 566902: weekdayPace },
    });
    await withService(
      fakeSmartlead({ campaigns: [] }),
      slack,
      fakeSupabase(),
      async (watch, state) => {
        state.putHeyreach("techevo", 566902, {
          status: "IN_PROGRESS",
          seen: true,
          notifiedUnder7: false,
          notifiedPendingDry: false,
        });
        const sat = await watch.run(new Date("2026-09-05T16:10:00.000Z"));
        assert.equal(sat.heyreach, 0);
        assert.equal(slack.posted.length, 0);
        assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedUnder7, true);

        const mon = await watch.run(new Date("2026-09-07T16:10:00.000Z"));
        assert.equal(mon.heyreach, 0);
        assert.equal(slack.posted.length, 0);
      },
      [heyreach],
    );
  });
});
