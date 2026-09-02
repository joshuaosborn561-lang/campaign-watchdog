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
import { classifyInboxes } from "../lib/inboxes.js";
import {
  formatDailyDigest,
  formatFinishedMessage,
  formatNearlyDoneMessage,
  formatPauseMessage,
  type DigestCampaign,
} from "../lib/digest.js";
import {
  isSendDay,
  parseCampaignSchedule,
  windowHasEnded,
} from "../lib/schedule.js";
import { diagnoseSending } from "../lib/sending.js";
import { isCompletionIgnoredCampaign, isNoiseCampaign } from "../lib/names.js";
import { resolveClient } from "../lib/clients.js";
import {
  formatClientPulse,
  parseTodayVolume,
  resolvePulseSlot,
  rollupClientPulse,
  stillPausedCampaigns,
  type PausedPulseRow,
} from "../lib/pulse.js";
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
import { hourInZone, ymdInZone } from "../lib/time.js";
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
    const digestRows: DigestCampaign[] = [];
    let digestPending = 0;

    const [campaigns, clients, supabaseCampaigns, registry] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.supabase.enabled()
        ? this.supabase.fetchCampaignNames().catch(() => new Map<number, CampaignNameRow>())
        : Promise.resolve(new Map<number, CampaignNameRow>()),
      this.supabase.enabled()
        ? this.supabase.fetchClientRegistry().catch(() => new Map<number, string>())
        : Promise.resolve(new Map<number, string>()),
    ]);

    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const watch = new Set(this.config.watchStatuses);
    const day = ymdInZone(now, this.config.sendShortfallTimezone);
    const inventory: ClientCampaignLeadRow[] = [];
    const pendingCompletion: PendingCompletion[] = [];

    for (const campaign of campaigns) {
      if (isNoiseCampaign(campaign.name)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (!watch.has(status) && status !== "PAUSED") continue;
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
          now,
          result,
          digestRows,
          inventory,
          pendingCompletion,
          onPendingDigest: () => {
            digestPending += 1;
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${campaign.id} ${campaign.name}: ${message}`);
      }
      await sleep(150);
    }

    await this.flushCompletionAlerts(pendingCompletion, inventory, now, result);

    const hour = hourInZone(now, this.config.sendShortfallTimezone);
    const wrapUp = hour >= 19;
    if (digestRows.length && (digestPending === 0 || wrapUp)) {
      const text = formatDailyDigest(day, digestRows);
      if (text) {
        const key = `digest:v3:${day}`;
        if (!(await this.alreadySent(key))) {
          await this.notify(text, {
            key,
            campaignId: 0,
            clientName: "All clients",
            campaignName: `Daily digest ${day}`,
            kind: "digest",
            payload: { day, clients: digestRows.length },
          });
          this.state.setLastDigestDay(day);
          result.digest = 1;
        } else {
          this.state.setLastDigestDay(day);
        }
      }
    }

    await this.inspectHeyReach(day, result);
    await this.state.save();
    return result;
  }

  async runPulse(now = new Date()): Promise<{ posted: boolean; clients: number; paused: number }> {
    const timeZone = this.config.sendShortfallTimezone;
    const resolved = resolvePulseSlot(
      now,
      timeZone,
      this.config.pulseHours,
      this.config.pulseWeekdays,
    );
    if (!resolved) {
      return { posted: false, clients: 0, paused: 0 };
    }

    const { day, hour, slot } = resolved;
    const key = `pulse:v2:${slot}`;
    if (this.state.lastPulseSlot() === slot || (await this.alreadySent(key))) {
      this.state.setLastPulseSlot(slot);
      return { posted: false, clients: 0, paused: 0 };
    }

    const [campaigns, clients, supabaseCampaigns, registry] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.supabase.enabled()
        ? this.supabase.fetchCampaignNames().catch(() => new Map<number, CampaignNameRow>())
        : Promise.resolve(new Map<number, CampaignNameRow>()),
      this.supabase.enabled()
        ? this.supabase.fetchClientRegistry().catch(() => new Map<number, string>())
        : Promise.resolve(new Map<number, string>()),
    ]);
    const clientsById = new Map(clients.map((client) => [client.id, client]));
    const rows: Array<{
      clientId: number | null;
      clientName: string;
      sent: number;
      bounced: number;
    }> = [];
    const paused: PausedPulseRow[] = stillPausedCampaigns(campaigns).map((campaign) => {
      const resolvedClient = resolveClient(campaign, clientsById, supabaseCampaigns, registry);
      return {
        clientName: resolvedClient.clientName,
        campaignName: campaign.name,
      };
    });

    for (const campaign of campaigns) {
      if (isNoiseCampaign(campaign.name)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE" && status !== "PAUSED") continue;
      const resolvedClient = resolveClient(campaign, clientsById, supabaseCampaigns, registry);
      try {
        const today = await this.smartlead.getCampaignAnalyticsByDate(campaign.id, day, day);
        const volume = parseTodayVolume(today, day);
        rows.push({
          clientId: resolvedClient.clientId,
          clientName: resolvedClient.clientName,
          sent: volume.sent,
          bounced: volume.bounced,
        });
      } catch (error) {
        console.warn(
          `[watchdog] pulse #${campaign.id} ${campaign.name}:`,
          error instanceof Error ? error.message : error,
        );
      }
      await sleep(120);
    }

    const rolled = rollupClientPulse(rows);
    if (!rolled.length && !paused.length) return { posted: false, clients: 0, paused: 0 };

    await this.notify(
      formatClientPulse({
        day,
        hour,
        clients: rolled,
        bounceWarn: this.config.bounceAutoPauseThreshold,
        paused,
      }),
      {
        key,
        campaignId: 0,
        clientName: "All clients",
        campaignName: `Client pulse ${slot}`,
        kind: "pulse",
        payload: { day, hour, clients: rolled, paused },
      },
    );
    this.state.setLastPulseSlot(slot);
    await this.state.save();
    return { posted: true, clients: rolled.length, paused: paused.length };
  }

  private async inspectCampaign(input: {
    campaign: SmartleadCampaign;
    status: string;
    clientsById: Map<number, SmartleadClientRecord>;
    supabaseCampaigns: Map<number, CampaignNameRow>;
    registry: Map<number, string>;
    day: string;
    now: Date;
    result: WatchResult;
    digestRows: DigestCampaign[];
    inventory: ClientCampaignLeadRow[];
    pendingCompletion: PendingCompletion[];
    onPendingDigest: () => void;
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
        // Record 50% (and anything we will not Slack) now. 75/90/100 stay
        // pending until Slack succeeds so an after-hours skip cannot eat them.
        for (const threshold of fresh) {
          if (isCompletionIgnoredCampaign(campaignName) || !slackable.has(threshold)) {
            snapshot.notifiedThresholds.push(threshold);
          }
        }
        if (!isCompletionIgnoredCampaign(campaignName)) {
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
    if (!firstSeen && becamePaused) {
      const key = `pause:v1:${input.campaign.id}:${input.day}`;
      if (!(await this.alreadySent(key))) {
        await this.notify(
          formatPauseMessage({
            clientName,
            campaignName,
            autobounce: verdict.autobounce,
            bounceRate: verdict.bounceRate,
            sent: verdict.sent,
            reason: verdict.reason,
          }),
          {
            key,
            campaignId: input.campaign.id,
            clientName,
            campaignName,
            kind: verdict.autobounce ? "autobounce" : "pause",
            payload: { ...verdict },
          },
        );
        snapshot.lastAutobounceAlertAt = new Date().toISOString();
        input.result.autobounce += 1;
      }
    }

    if (input.status === "ACTIVE") {
      const schedule = parseCampaignSchedule(
        { ...(unwrap(settings) ?? {}), ...(unwrap(detail) ?? {}) },
        {
          timeZone: this.config.sendShortfallTimezone,
          gapMinutes: this.config.mailboxMinTimeGapMins,
        },
      );
      const sendDay = isSendDay(schedule, input.now);
      const afterWindow = windowHasEnded(schedule, input.now);
      if (firstSeen) {
        snapshot.lastSendingAlertDay = input.day;
      } else if (!sendDay) {
        // not a send day
      } else if (!afterWindow) {
        input.onPendingDigest();
      } else if (stats != null) {
        const accounts = await this.smartlead.getCampaignEmailAccounts(input.campaign.id);
        const inboxes = classifyInboxes(
          accounts.map((row) => ({
            id: row.id,
            email: row.from_email ?? row.email ?? row.username,
            smtpOk: row.is_smtp_success !== false,
            imapOk: row.is_imap_success !== false,
            dailySent: row.daily_sent_count ?? 0,
          })),
        );
        const todayVolume = parseTodayVolume(
          await this.smartlead
            .getCampaignAnalyticsByDate(input.campaign.id, input.day, input.day)
            .catch(() => null),
          input.day,
        );
        const sentToday = todayVolume.sent;
        const diagnosis = diagnoseSending({
          sent: sentToday,
          remaining: stats.remaining,
          schedule,
          inboxes,
          messagePerDay: this.config.messagePerDay,
        });
        input.digestRows.push({
          clientId,
          clientName,
          campaignName,
          sent: sentToday,
          bounced: todayVolume.bounced,
          remaining: stats.remaining,
          notStarted: stats.notStarted,
          inProgress: stats.inProgress,
          staffable: inboxes.staffable,
          attached: inboxes.attached,
          kind: diagnosis?.kind ?? "unknown",
          shouldAlert: Boolean(diagnosis?.shouldAlert),
          status: "ACTIVE",
        });
        if (diagnosis?.shouldAlert) input.result.sending += 1;
      }
    } else if (input.status === "PAUSED" && stats) {
      const todayVolume = parseTodayVolume(
        await this.smartlead
          .getCampaignAnalyticsByDate(input.campaign.id, input.day, input.day)
          .catch(() => null),
        input.day,
      );
      input.digestRows.push({
        clientId,
        clientName,
        campaignName,
        sent: todayVolume.sent,
        bounced: todayVolume.bounced,
        remaining: stats.remaining,
        notStarted: stats.notStarted,
        inProgress: stats.inProgress,
        staffable: 0,
        attached: 0,
        kind: "unknown",
        shouldAlert: false,
        status: "PAUSED",
      });
    }

    snapshot.status = input.status;
    snapshot.seen = true;
    this.state.put(input.campaign.id, snapshot);
  }

  private async inspectHeyReach(day: string, result: WatchResult): Promise<void> {
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

    if (actionable) {
      const kinds: Array<"under7" | "pending-dry"> = [];
      if (freshUnder7) kinds.push("under7");
      if (freshDry) kinds.push("pending-dry");
      const already = await Promise.all(kinds.map((kind) => this.alreadySent(heyreachAlertKey(kind, input.campaign.id))));
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
    _now: Date,
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

