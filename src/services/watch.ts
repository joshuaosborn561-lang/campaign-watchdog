import type { AppConfig } from "../config.js";
import { HeyReachClient } from "../clients/heyreach.js";
import {
  SmartleadClient,
  sleep,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { CampaignNameRow, SupabaseStore } from "../clients/supabase.js";
import { detectAutobounce } from "../lib/autobounce.js";
import { parseCampaignLeadStats } from "../lib/completion.js";
import { formatPauseMessage } from "../lib/digest.js";
import { isSendDay, parseCampaignSchedule } from "../lib/schedule.js";
import { isNoiseCampaign } from "../lib/names.js";
import { resolveClient } from "../lib/clients.js";
import { parseTodayVolume } from "../lib/pulse.js";
import {
  formatEodReport,
  formatMiddayReport,
  isVolumeSkippedCampaign,
  resolveEodSlot,
  resolveVolumeSlot,
  rollupClientEod,
  rollupClientVolume,
  type VolumeCampaignInput,
} from "../lib/volume.js";
import { unwrap } from "../lib/parse.js";
import { isWeekendInZone, ymdInZone } from "../lib/time.js";
import type { StateStore } from "../state/store.js";

export { resolveClient, resolveClientName } from "../lib/clients.js";

export interface WatchResult {
  scanned: number;
  completion: number;
  autobounce: number;
  sending: number;
  digest: number;
  heyreach: number;
  errors: string[];
}

export type HeyReachWorkspaceClient = Pick<
  HeyReachClient,
  "workspace" | "listCampaigns" | "getCampaign" | "getOverallStats"
>;

export class WatchService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly supabase: SupabaseStore,
    _heyreachClients?: HeyReachWorkspaceClient[],
  ) {}

  /**
   * 15-minute watch. The only Slack it may send is an immediate autobounce
   * pause (weekdays). Completion, digest, pulse, sending, and HeyReach
   * never post from this loop.
   */
  async run(now = new Date()): Promise<WatchResult> {
    const result: WatchResult = {
      scanned: 0,
      completion: 0,
      autobounce: 0,
      sending: 0,
      digest: 0,
      heyreach: 0,
      errors: [],
    };
    const allowSlack = !isWeekendInZone(now, this.config.sendShortfallTimezone);

    const [campaigns, clients, supabaseCampaigns, registry] = await this.loadDirectories();
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const watch = new Set(this.config.watchStatuses);
    const day = ymdInZone(now, this.config.sendShortfallTimezone);

    for (const campaign of campaigns) {
      if (isNoiseCampaign(campaign.name)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (!watch.has(status)) continue;
      result.scanned += 1;
      try {
        await this.inspectCampaign({
          campaign,
          status,
          clientsById,
          supabaseCampaigns,
          registry,
          day,
          allowSlack,
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
      }
      await sleep(150);
    }

    await this.state.save();
    return result;
  }

  /**
   * Weekday noon send tracking. One line per active client; flags projected
   * more than 10% under the 1,200-send day. Read-only.
   */
  async runVolumeCheck(
    now = new Date(),
  ): Promise<{ posted: boolean; flagged: number; clients: number }> {
    const timeZone = this.config.sendShortfallTimezone;
    const resolved = resolveVolumeSlot(
      now,
      timeZone,
      this.config.volumeWeekdays,
      this.config.volumeHour,
    );
    if (!resolved) {
      return { posted: false, flagged: 0, clients: 0 };
    }

    const { day, slot } = resolved;
    const key = `volume:v1:${day}`;
    if (this.state.lastVolumeDay() === day || (await this.alreadySent(key))) {
      this.state.setLastVolumeDay(day);
      return { posted: false, flagged: 0, clients: 0 };
    }

    const rows = await this.collectActiveClientRows(now, day);
    const rolled = rollupClientVolume(rows, now, timeZone, this.config.volumeHour);
    const text = formatMiddayReport(rolled, day);
    this.state.setLastVolumeDay(day);
    if (!text) {
      await this.state.save();
      return { posted: false, flagged: 0, clients: rolled.length };
    }

    await this.notify(text, {
      key,
      campaignId: 0,
      clientName: "All clients",
      campaignName: `Midday volume ${slot}`,
      kind: "volume",
      payload: {
        day,
        clients: rolled.map((row) => ({
          clientId: row.clientId,
          clientName: row.clientName,
          sent: row.sent,
          projected: row.projected,
          under: row.under,
        })),
      },
    });
    await this.state.save();
    return {
      posted: true,
      flagged: rolled.filter((row) => row.under).length,
      clients: rolled.length,
    };
  }

  /**
   * Weekday 5–6pm CT wrap-up. Sends today vs 1,200, plus clients with
   * fewer than 7 days of email sends left. Read-only.
   */
  async runEndOfDay(
    now = new Date(),
  ): Promise<{ posted: boolean; under: number; topUp: number; clients: number }> {
    const timeZone = this.config.sendShortfallTimezone;
    const resolved = resolveEodSlot(now, timeZone, this.config.volumeWeekdays, this.config.eodHour);
    if (!resolved) {
      return { posted: false, under: 0, topUp: 0, clients: 0 };
    }

    const { day, slot } = resolved;
    const key = `eod:v1:${day}`;
    if (this.state.lastEodDay() === day || (await this.alreadySent(key))) {
      this.state.setLastEodDay(day);
      return { posted: false, under: 0, topUp: 0, clients: 0 };
    }

    const rows = await this.collectActiveClientRows(now, day);
    const rolled = rollupClientEod(
      rows,
      this.config.volumeTargetSends,
      this.config.volumeAlertMax,
    );
    const text = formatEodReport(rolled, day, this.config.volumeTargetSends);
    this.state.setLastEodDay(day);
    if (!text) {
      await this.state.save();
      return { posted: false, under: 0, topUp: 0, clients: rolled.length };
    }

    await this.notify(text, {
      key,
      campaignId: 0,
      clientName: "All clients",
      campaignName: `EOD volume ${slot}`,
      kind: "eod",
      payload: {
        day,
        clients: rolled.map((row) => ({
          clientId: row.clientId,
          clientName: row.clientName,
          sent: row.sent,
          remaining: row.remaining,
          daysLeft: row.daysLeft,
          under: row.under,
          needsTopUp: row.needsTopUp,
        })),
      },
    });
    await this.state.save();
    return {
      posted: true,
      under: rolled.filter((row) => row.under).length,
      topUp: rolled.filter((row) => row.needsTopUp).length,
      clients: rolled.length,
    };
  }

  private async collectActiveClientRows(now: Date, day: string): Promise<VolumeCampaignInput[]> {
    const [campaigns, clients, supabaseCampaigns, registry] = await this.loadDirectories();
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const mute = {
      ids: this.config.pulseExcludeCampaignIds,
      names: this.config.pulseExcludeCampaignNames,
    };
    const timeZone = this.config.sendShortfallTimezone;
    const rows: VolumeCampaignInput[] = [];

    for (const campaign of campaigns) {
      if (isVolumeSkippedCampaign(campaign, mute)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE") continue;
      const resolvedClient = resolveClient(campaign, clientsById, supabaseCampaigns, registry);
      try {
        const [today, settings, detail, analytics] = await Promise.all([
          this.smartlead.getCampaignAnalyticsByDate(campaign.id, day, day).catch(() => null),
          this.smartlead.getCampaignSettings(campaign.id).catch(() => null),
          this.smartlead.getCampaign(campaign.id).catch(() => campaign),
          this.smartlead.getCampaignAnalytics(campaign.id).catch(() => null),
        ]);
        const schedule = parseCampaignSchedule(
          { ...(unwrap(settings) ?? {}), ...(unwrap(detail) ?? {}) },
          {
            timeZone,
            gapMinutes: this.config.mailboxMinTimeGapMins,
          },
        );
        if (!isSendDay(schedule, now)) continue;
        const volume = parseTodayVolume(today, day);
        const stats =
          parseCampaignLeadStats(analytics) ?? parseCampaignLeadStats(detail);
        rows.push({
          clientId: resolvedClient.clientId,
          clientName: resolvedClient.clientName,
          sent: volume.sent,
          remaining: stats?.remaining ?? null,
          schedule,
        });
      } catch (error) {
        console.warn(
          `[watchdog] volume #${campaign.id} ${campaign.name}:`,
          error instanceof Error ? error.message : error,
        );
      }
      await sleep(120);
    }
    return rows;
  }

  private async loadDirectories(): Promise<
    [SmartleadCampaign[], SmartleadClientRecord[], Map<number, CampaignNameRow>, Map<number, string>]
  > {
    return Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.supabase.enabled()
        ? this.supabase.fetchCampaignNames().catch(() => new Map<number, CampaignNameRow>())
        : Promise.resolve(new Map<number, CampaignNameRow>()),
      this.supabase.enabled()
        ? this.supabase.fetchClientRegistry().catch(() => new Map<number, string>())
        : Promise.resolve(new Map<number, string>()),
    ]);
  }

  private async inspectCampaign(input: {
    campaign: SmartleadCampaign;
    status: string;
    clientsById: Map<number, SmartleadClientRecord>;
    supabaseCampaigns: Map<number, CampaignNameRow>;
    registry: Map<number, string>;
    day: string;
    allowSlack: boolean;
    result: WatchResult;
  }): Promise<void> {
    const snapshot = this.state.snapshot(input.campaign.id);
    const firstSeen = !snapshot.seen;

    const [detail, settings, analytics] = await Promise.all([
      this.smartlead.getCampaign(input.campaign.id).catch(() => input.campaign),
      this.smartlead.getCampaignSettings(input.campaign.id).catch(() => null),
      this.smartlead.getCampaignAnalytics(input.campaign.id).catch(() => null),
    ]);

    const resolved = resolveClient(
      input.campaign,
      input.clientsById,
      input.supabaseCampaigns,
      input.registry,
      detail,
    );

    const verdict = detectAutobounce({
      status: input.status,
      campaign: detail,
      settings,
      analytics,
      fallbackThreshold: this.config.bounceAutoPauseThreshold,
      minSample: this.config.minBounceSample,
    });
    const becamePaused = snapshot.seen && snapshot.status !== "PAUSED" && verdict.paused;
    if (input.allowSlack && !firstSeen && becamePaused && verdict.autobounce) {
      const key = `pause:v1:${input.campaign.id}:${input.day}`;
      if (!(await this.alreadySent(key))) {
        await this.notify(
          formatPauseMessage({
            clientName: resolved.clientName,
            campaignName: input.campaign.name,
            campaignId: input.campaign.id,
            autobounce: true,
            bounceRate: verdict.bounceRate,
            sent: verdict.sent,
            reason: verdict.reason,
          }),
          {
            key,
            campaignId: input.campaign.id,
            clientName: resolved.clientName,
            campaignName: input.campaign.name,
            kind: "autobounce",
            payload: { ...verdict },
          },
        );
        snapshot.lastAutobounceAlertAt = new Date().toISOString();
        input.result.autobounce += 1;
      }
    }

    snapshot.status = input.status;
    snapshot.seen = true;
    this.state.put(input.campaign.id, snapshot);
  }

  private async alreadySent(key: string): Promise<boolean> {
    if (!this.supabase.enabled()) return false;
    try {
      return await this.supabase.hasAlert(key);
    } catch {
      return false;
    }
  }

  private async notify(
    text: string,
    alert: {
      key: string;
      campaignId: number;
      clientName: string;
      campaignName: string;
      kind: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.slack.post(text);
    if (this.supabase.enabled()) {
      try {
        await this.supabase.markAlert(alert);
      } catch (error) {
        console.warn("[watchdog] failed to persist alert key", error);
      }
    }
  }
}
