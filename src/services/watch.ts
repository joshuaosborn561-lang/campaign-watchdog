import type { AppConfig } from "../config.js";
import {
  HeyReachClient,
  parseProgressStats,
  type HeyReachCampaign,
} from "../clients/heyreach.js";
import {
  SmartleadClient,
  sleep,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { CampaignNameRow, SupabaseStore } from "../clients/supabase.js";
import { detectAutobounce } from "../lib/autobounce.js";
import {
  clientHasOtherActiveLeads,
  completionAlertsToPost,
  completionPercent,
  newThresholds,
  parseCampaignLeadStats,
  thresholdsReached,
  type ClientCampaignLeadRow,
} from "../lib/completion.js";
import {
  formatFinishedMessage,
  formatNearlyDoneMessage,
  formatPauseMessage,
} from "../lib/digest.js";
import { isSendDay, parseCampaignSchedule } from "../lib/schedule.js";
import { isCompletionIgnoredCampaign, isNoiseCampaign } from "../lib/names.js";
import { resolveClient } from "../lib/clients.js";
import {
  attachPulseUnder,
  formatClientPulse,
  isPulseExcludedCampaign,
  parseTodayVolume,
  pausedSeenOnDay,
  resolvePulseSlot,
  rollupClientPulse,
  stillPausedCampaigns,
  type PausedPulseRow,
} from "../lib/pulse.js";
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
import {
  addUtcDays,
  formatHeyReachRunwayMessage,
  heyreachAlertFlags,
  heyreachAlertKey,
  heyreachRemaining,
  isoDayEnd,
  isoDayStart,
  runwayDays,
  shouldAlertHeyReach,
  weekdayPaceFromStats,
} from "../lib/heyreach.js";
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

interface PendingCompletion {
  campaignId: number;
  clientId: number | null;
  clientName: string;
  campaignName: string;
  threshold: number;
  percent: number;
  remaining: number;
  contacted: number;
  total: number;
}

export class WatchService {
  private readonly heyreachClients: HeyReachWorkspaceClient[];

  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly supabase: SupabaseStore,
    heyreachClients?: HeyReachWorkspaceClient[],
  ) {
    this.heyreachClients =
      heyreachClients ?? config.heyreachWorkspaces.map((workspace) => new HeyReachClient(workspace));
  }

  /**
   * 15-minute watch. Weekday Slack: autobounce pauses, 75/90/100 completion,
   * and HeyReach runway / pending-dry. No digest or weekend posts. The 2-hour
   * pulse is a separate cron (`runPulse`).
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
    const inventory: ClientCampaignLeadRow[] = [];
    const pendingCompletion: PendingCompletion[] = [];

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
          inventory,
          pendingCompletion,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
      }
      await sleep(150);
    }

    if (allowSlack) {
      await this.flushCompletionAlerts(pendingCompletion, inventory, result);
    }
    await this.inspectHeyReach(day, result, allowSlack);
    await this.state.save();
    return result;
  }

  /**
   * Weekday 2-hour sent-today pulse. Client summary only — no Off track / low-on-leads
   * dump. Mentions Cayden + Josh when any client is projected *under*. Read-only.
   */
  async runPulse(
    now = new Date(),
  ): Promise<{ posted: boolean; clients: number; under: number; paused: number }> {
    const timeZone = this.config.sendShortfallTimezone;
    const resolved = resolvePulseSlot(
      now,
      timeZone,
      this.config.pulseHours,
      this.config.pulseWeekdays,
    );
    if (!resolved) {
      return { posted: false, clients: 0, under: 0, paused: 0 };
    }

    const { day, hour, slot } = resolved;
    const key = `pulse:v3:${slot}`;
    if (this.state.lastPulseSlot() === slot || (await this.alreadySent(key))) {
      this.state.setLastPulseSlot(slot);
      return { posted: false, clients: 0, under: 0, paused: 0 };
    }

    const [campaigns, clients, supabaseCampaigns, registry] = await this.loadDirectories();
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const pulseExclude = {
      ids: this.config.pulseExcludeCampaignIds,
      names: this.config.pulseExcludeCampaignNames,
    };
    const rows: Array<{
      clientId: number | null;
      clientName: string;
      sent: number;
      bounced: number;
    }> = [];
    const volumeInputs: VolumeCampaignInput[] = [];
    const paused: PausedPulseRow[] = stillPausedCampaigns(campaigns, pulseExclude).map(
      (campaign) => {
        const resolvedClient = resolveClient(campaign, clientsById, supabaseCampaigns, registry);
        return {
          clientName: resolvedClient.clientName,
          campaignName: campaign.name,
          campaignId: campaign.id,
        };
      },
    );

    for (const campaign of campaigns) {
      if (isNoiseCampaign(campaign.name)) continue;
      if (isPulseExcludedCampaign(campaign, pulseExclude)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE" && status !== "PAUSED") continue;
      const resolvedClient = resolveClient(campaign, clientsById, supabaseCampaigns, registry);
      try {
        const [today, settings, detail] = await Promise.all([
          this.smartlead.getCampaignAnalyticsByDate(campaign.id, day, day).catch(() => null),
          status === "ACTIVE"
            ? this.smartlead.getCampaignSettings(campaign.id).catch(() => null)
            : Promise.resolve(null),
          status === "ACTIVE"
            ? this.smartlead.getCampaign(campaign.id).catch(() => campaign)
            : Promise.resolve(campaign),
        ]);
        const volume = parseTodayVolume(today, day);
        rows.push({
          clientId: resolvedClient.clientId,
          clientName: resolvedClient.clientName,
          sent: volume.sent,
          bounced: volume.bounced,
        });
        if (status === "ACTIVE") {
          const schedule = parseCampaignSchedule(
            { ...(unwrap(settings) ?? {}), ...(unwrap(detail) ?? {}) },
            {
              timeZone,
              gapMinutes: this.config.mailboxMinTimeGapMins,
            },
          );
          if (isSendDay(schedule, now)) {
            volumeInputs.push({
              clientId: resolvedClient.clientId,
              clientName: resolvedClient.clientName,
              sent: volume.sent,
              remaining: null,
              schedule,
            });
          }
        }
      } catch (error) {
        console.warn(
          `[watchdog] pulse #${campaign.id} ${campaign.name}:`,
          error instanceof Error ? error.message : error,
        );
      }
      await sleep(120);
    }

    const rolled = rollupClientPulse(rows);
    if (!rolled.length && !paused.length) {
      return { posted: false, clients: 0, under: 0, paused: 0 };
    }

    const volumeRows = rollupClientVolume(volumeInputs, now, timeZone, hour);
    const clientsWithUnder = attachPulseUnder(rolled, volumeRows);
    const underCount = clientsWithUnder.filter((row) => row.under).length;
    const pausedToday = pausedSeenOnDay(
      paused,
      new Map(
        paused.flatMap((row) =>
          row.campaignId != null
            ? [[row.campaignId, this.state.snapshot(row.campaignId).lastAutobounceAlertAt] as const]
            : [],
        ),
      ),
      day,
      timeZone,
    );

    const text = formatClientPulse({
      day,
      hour,
      clients: clientsWithUnder,
      bounceWarn: this.config.bounceAutoPauseThreshold,
      paused,
      pausedToday,
      exclude: pulseExclude,
      mentionUserIds:
        underCount > 0
          ? [this.config.slackCaydenUserId, this.config.slackJoshUserId]
          : [],
    });
    this.state.setLastPulseSlot(slot);
    if (!text) {
      await this.state.save();
      return { posted: false, clients: rolled.length, under: underCount, paused: paused.length };
    }

    await this.notify(text, {
      key,
      campaignId: 0,
      clientName: "All clients",
      campaignName: `Client pulse ${slot}`,
      kind: "pulse",
      payload: {
        day,
        hour,
        clients: clientsWithUnder,
        paused,
        under: underCount,
      },
    });
    await this.state.save();
    return {
      posted: true,
      clients: rolled.length,
      under: underCount,
      paused: paused.length,
    };
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
   * Weekday 5–6pm CT wrap-up. Sends today vs 1,200, plus a per-client
   * count of lists that are low on leads (<7 days at 1,200/day). Read-only.
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
    inventory: ClientCampaignLeadRow[];
    pendingCompletion: PendingCompletion[];
  }): Promise<void> {
    const snapshot = this.state.snapshot(input.campaign.id);
    const firstSeen = !snapshot.seen;
    const campaignName = input.campaign.name;

    const [detail, settings, analytics, statistics] = await Promise.all([
      this.smartlead.getCampaign(input.campaign.id).catch(() => input.campaign),
      this.smartlead.getCampaignSettings(input.campaign.id).catch(() => null),
      this.smartlead.getCampaignAnalytics(input.campaign.id).catch(() => null),
      this.smartlead.getCampaignStatistics(input.campaign.id).catch(() => null),
    ]);

    const resolved = resolveClient(
      input.campaign,
      input.clientsById,
      input.supabaseCampaigns,
      input.registry,
      detail,
    );
    const clientName = resolved.clientName;
    const clientId = resolved.clientId;
    const inventoryRow: ClientCampaignLeadRow = {
      id: input.campaign.id,
      clientId,
      clientName,
      campaignName,
      status: input.status,
      remaining: null,
    };
    input.inventory.push(inventoryRow);

    const stats =
      parseCampaignLeadStats(analytics) ??
      parseCampaignLeadStats(statistics) ??
      parseCampaignLeadStats(detail);

    if (stats) {
      const percent = completionPercent(stats);
      snapshot.lastCompletionPct = percent;
      inventoryRow.remaining = stats.remaining;
      if (firstSeen) {
        snapshot.notifiedThresholds = thresholdsReached(
          percent,
          this.config.completionThresholds,
        );
      } else {
        const fresh = newThresholds(
          percent,
          snapshot.notifiedThresholds,
          this.config.completionThresholds,
        );
        const slackable = new Set(completionAlertsToPost(fresh, percent));
        // Record 50% (and anything we will not Slack) now. On weekdays,
        // 75/90/100 stay pending until Slack succeeds. On weekends they
        // are marked here so Monday does not catch up.
        for (const threshold of fresh) {
          if (
            isCompletionIgnoredCampaign(campaignName) ||
            !slackable.has(threshold) ||
            !input.allowSlack
          ) {
            snapshot.notifiedThresholds.push(threshold);
          }
        }
        if (input.allowSlack && !isCompletionIgnoredCampaign(campaignName)) {
          for (const threshold of slackable) {
            input.pendingCompletion.push({
              campaignId: input.campaign.id,
              clientId,
              clientName,
              campaignName,
              threshold,
              percent,
              remaining: stats.remaining,
              contacted: stats.contacted,
              total: stats.total,
            });
          }
        }
      }
    }

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
            clientName,
            campaignName,
            campaignId: input.campaign.id,
            autobounce: true,
            bounceRate: verdict.bounceRate,
            sent: verdict.sent,
            reason: verdict.reason,
          }),
          {
            key,
            campaignId: input.campaign.id,
            clientName,
            campaignName,
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

  private async inspectHeyReach(
    day: string,
    result: WatchResult,
    allowSlack: boolean,
  ): Promise<void> {
    if (!this.heyreachClients.length) return;
    const lookback = Math.max(1, this.config.heyreachPaceLookbackDays);
    const startDay = addUtcDays(day, -lookback + 1);
    for (const client of this.heyreachClients) {
      let campaigns: HeyReachCampaign[] = [];
      try {
        campaigns = await client.listCampaigns(["IN_PROGRESS"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`heyreach ${client.workspace.id}: ${message}`);
        continue;
      }
      for (const campaign of campaigns) {
        const status = String(campaign.status ?? "").toUpperCase();
        if (status !== "IN_PROGRESS") continue;
        result.scanned += 1;
        try {
          await this.inspectHeyReachCampaign({
            client,
            campaign,
            status,
            day,
            startDay,
            result,
            allowSlack,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`heyreach ${client.workspace.id} #${campaign.id}: ${message}`);
        }
        await sleep(150);
      }
    }
  }

  private async inspectHeyReachCampaign(input: {
    client: HeyReachWorkspaceClient;
    campaign: HeyReachCampaign;
    status: string;
    day: string;
    startDay: string;
    result: WatchResult;
    allowSlack: boolean;
  }): Promise<void> {
    const workspaceId = input.client.workspace.id;
    const clientName = input.client.workspace.clientName;
    const snapshot = this.state.heyreachSnapshot(workspaceId, input.campaign.id);
    const firstSeen = !snapshot.seen;

    let stats = input.campaign.progressStats;
    if (!stats) {
      const detail = await input.client.getCampaign(input.campaign.id).catch(() => null);
      stats = parseProgressStats(
        unwrap(detail)?.progressStats ?? unwrap(detail)?.progress_stats ?? detail,
      );
    }
    const pending = stats?.pending ?? 0;
    const inProgress = stats?.inProgress ?? 0;
    const remaining = heyreachRemaining({ pending, inProgress });
    const total = stats?.total ?? remaining;

    let weekdayPace: number | null = null;
    let weekdaySamples = 0;
    try {
      const raw = await input.client.getOverallStats({
        campaignId: input.campaign.id,
        startDate: isoDayStart(input.startDay),
        endDate: isoDayEnd(input.day),
      });
      const pace = weekdayPaceFromStats(raw, this.config.heyreachWeekdays);
      weekdayPace = pace.pace;
      weekdaySamples = pace.samples;
    } catch (error) {
      console.warn(
        `[watchdog] heyreach #${input.campaign.id} stats:`,
        error instanceof Error ? error.message : error,
      );
    }

    const daysLeft = runwayDays(remaining, weekdayPace);
    const flags = heyreachAlertFlags(
      {
        campaignId: input.campaign.id,
        status: input.status,
        pending,
        runwayDays: daysLeft,
      },
      {
        excludeIds: this.config.heyreachExcludeIds,
        runwayDays: this.config.heyreachRunwayDays,
      },
    );

    snapshot.status = input.status;
    snapshot.lastPending = pending;
    snapshot.lastRemaining = remaining;
    snapshot.lastRunwayDays = daysLeft;

    if (firstSeen) {
      snapshot.notifiedUnder7 = flags.under7;
      snapshot.notifiedPendingDry = flags.pendingDry;
      snapshot.seen = true;
      this.state.putHeyreach(workspaceId, input.campaign.id, snapshot);
      return;
    }

    if (!flags.under7) snapshot.notifiedUnder7 = false;
    if (!flags.pendingDry) snapshot.notifiedPendingDry = false;

    const freshUnder7 = flags.under7 && !snapshot.notifiedUnder7;
    const freshDry = flags.pendingDry && !snapshot.notifiedPendingDry;
    const actionable = shouldAlertHeyReach(flags) && (freshUnder7 || freshDry);

    if (actionable && !input.allowSlack) {
      snapshot.notifiedUnder7 = flags.under7 || snapshot.notifiedUnder7;
      snapshot.notifiedPendingDry = flags.pendingDry || snapshot.notifiedPendingDry;
      snapshot.seen = true;
      this.state.putHeyreach(workspaceId, input.campaign.id, snapshot);
      return;
    }

    if (actionable) {
      const kinds: Array<"under7" | "pending-dry"> = [];
      if (freshUnder7) kinds.push("under7");
      if (freshDry) kinds.push("pending-dry");
      const already = await Promise.all(
        kinds.map((kind) => this.alreadySent(heyreachAlertKey(kind, input.campaign.id))),
      );
      const open = kinds.filter((_, index) => !already[index]);
      if (open.length) {
        const text = formatHeyReachRunwayMessage({
          clientName,
          campaignName: input.campaign.name,
          remaining,
          pending,
          inProgress,
          runwayDays: daysLeft,
          under7: flags.under7,
          pendingDry: flags.pendingDry,
        });
        await this.notify(text, {
          key: heyreachAlertKey(open[0], input.campaign.id),
          campaignId: input.campaign.id,
          clientName,
          campaignName: input.campaign.name,
          kind: open[0] === "under7" ? "heyreach_under7" : "heyreach_pending_dry",
          payload: {
            workspace: workspaceId,
            pending,
            inProgress,
            remaining,
            total,
            weekdayPace,
            weekdaySamples,
            runwayDays: daysLeft,
            under7: flags.under7,
            pendingDry: flags.pendingDry,
          },
        });
        for (const kind of open.slice(1)) {
          if (!this.supabase.enabled()) continue;
          try {
            await this.supabase.markAlert({
              key: heyreachAlertKey(kind, input.campaign.id),
              campaignId: input.campaign.id,
              clientName,
              campaignName: input.campaign.name,
              kind: kind === "under7" ? "heyreach_under7" : "heyreach_pending_dry",
              payload: { workspace: workspaceId, remaining, pending, runwayDays: daysLeft },
            });
          } catch (error) {
            console.warn("[watchdog] failed to persist heyreach alert key", error);
          }
        }
        snapshot.notifiedUnder7 = flags.under7 || snapshot.notifiedUnder7;
        snapshot.notifiedPendingDry = flags.pendingDry || snapshot.notifiedPendingDry;
        input.result.heyreach += 1;
      } else {
        snapshot.notifiedUnder7 = flags.under7 || snapshot.notifiedUnder7;
        snapshot.notifiedPendingDry = flags.pendingDry || snapshot.notifiedPendingDry;
      }
    }

    snapshot.seen = true;
    this.state.putHeyreach(workspaceId, input.campaign.id, snapshot);
  }

  private async flushCompletionAlerts(
    pending: PendingCompletion[],
    inventory: ClientCampaignLeadRow[],
    result: WatchResult,
  ): Promise<void> {
    for (const item of pending) {
      const key = `completion:v1:${item.campaignId}:${item.threshold}`;
      if (await this.alreadySent(key)) {
        this.markThresholdNotified(item.campaignId, item.threshold);
        continue;
      }
      const text =
        item.threshold >= 100
          ? formatFinishedMessage({
              clientName: item.clientName,
              campaignName: item.campaignName,
              otherActiveLeads: clientHasOtherActiveLeads(
                {
                  id: item.campaignId,
                  clientId: item.clientId,
                  clientName: item.clientName,
                },
                inventory,
                isCompletionIgnoredCampaign,
              ),
            })
          : formatNearlyDoneMessage({
              clientName: item.clientName,
              campaignName: item.campaignName,
              threshold: item.threshold,
              remaining: item.remaining,
            });
      await this.notify(text, {
        key,
        campaignId: item.campaignId,
        clientName: item.clientName,
        campaignName: item.campaignName,
        kind: "completion",
        payload: {
          threshold: item.threshold,
          percent: item.percent,
          remaining: item.remaining,
          contacted: item.contacted,
          total: item.total,
        },
      });
      this.markThresholdNotified(item.campaignId, item.threshold);
      result.completion += 1;
    }
  }

  private markThresholdNotified(campaignId: number, threshold: number): void {
    const snapshot = this.state.snapshot(campaignId);
    if (!snapshot.notifiedThresholds.includes(threshold)) {
      snapshot.notifiedThresholds.push(threshold);
    }
    this.state.put(campaignId, snapshot);
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
