import type { AppConfig } from "../config.js";
import {
  SmartleadClient,
  clientDisplayName,
  sleep,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { CampaignNameRow, SupabaseStore } from "../clients/supabase.js";
import { detectAutobounce } from "../lib/autobounce.js";
import {
  completionPercent,
  newThresholds,
  parseCampaignLeadStats,
  parseSentCount,
  thresholdsReached,
} from "../lib/completion.js";
import { classifyInboxes } from "../lib/inboxes.js";
import {
  formatDailyDigest,
  formatFinishedMessage,
  formatPauseMessage,
  type DigestCampaign,
} from "../lib/digest.js";
import {
  isSendDay,
  parseCampaignSchedule,
  windowHasEnded,
} from "../lib/schedule.js";
import { diagnoseSending } from "../lib/sending.js";
import { isNoiseCampaign } from "../lib/names.js";
import {
  formatClientPulse,
  isPulseWindow,
  parseTodayVolume,
  pulseSlot,
  rollupClientPulse,
  stillPausedCampaigns,
  type PausedPulseRow,
} from "../lib/pulse.js";
import { unwrap } from "../lib/parse.js";
import { hourInZone, ymdInZone } from "../lib/time.js";
import type { StateStore } from "../state/store.js";

export interface WatchResult {
  scanned: number;
  completion: number;
  autobounce: number;
  sending: number;
  digest: number;
  errors: string[];
}

export class WatchService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly supabase: SupabaseStore,
  ) {}

  async run(now = new Date()): Promise<WatchResult> {
    const result: WatchResult = {
      scanned: 0,
      completion: 0,
      autobounce: 0,
      sending: 0,
      digest: 0,
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

    await this.state.save();
    return result;
  }

  async runPulse(now = new Date()): Promise<{ posted: boolean; clients: number; paused: number }> {
    const timeZone = this.config.sendShortfallTimezone;
    if (!isPulseWindow(now, timeZone, this.config.pulseHours, this.config.pulseWeekdays)) {
      return { posted: false, clients: 0, paused: 0 };
    }

    const day = ymdInZone(now, timeZone);
    const hour = hourInZone(now, timeZone);
    if (hour >= this.config.sendShortfallAfterHour) {
      return { posted: false, clients: 0, paused: 0 };
    }
    const slot = pulseSlot(day, hour);
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
    const rows: Array<{ clientName: string; sent: number; bounced: number }> = [];
    const paused: PausedPulseRow[] = stillPausedCampaigns(campaigns).map((campaign) => ({
      clientName: resolveClientName(campaign, clientsById, supabaseCampaigns, registry),
      campaignName: campaign.name,
    }));

    for (const campaign of campaigns) {
      if (isNoiseCampaign(campaign.name)) continue;
      const status = String(campaign.status ?? "").toUpperCase();
      if (status !== "ACTIVE" && status !== "PAUSED") continue;
      const clientName = resolveClientName(campaign, clientsById, supabaseCampaigns, registry);
      try {
        const today = await this.smartlead.getCampaignAnalyticsByDate(campaign.id, day, day);
        const volume = parseTodayVolume(today);
        rows.push({
          clientName,
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
    onPendingDigest: () => void;
  }): Promise<void> {
    const snapshot = this.state.snapshot(input.campaign.id);
    const firstSeen = !snapshot.seen;
    const clientName = resolveClientName(
      input.campaign,
      input.clientsById,
      input.supabaseCampaigns,
      input.registry,
    );
    const campaignName = input.campaign.name;

    const [detail, settings, analytics, statistics] = await Promise.all([
      this.smartlead.getCampaign(input.campaign.id).catch(() => input.campaign),
      this.smartlead.getCampaignSettings(input.campaign.id).catch(() => null),
      this.smartlead.getCampaignAnalytics(input.campaign.id).catch(() => null),
      this.smartlead.getCampaignStatistics(input.campaign.id).catch(() => null),
    ]);

    const stats =
      parseCampaignLeadStats(analytics) ??
      parseCampaignLeadStats(statistics) ??
      parseCampaignLeadStats(detail);

    if (stats) {
      const percent = completionPercent(stats);
      snapshot.lastCompletionPct = percent;
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
        for (const threshold of fresh) {
          const key = `completion:v1:${input.campaign.id}:${threshold}`;
          if (await this.alreadySent(key)) {
            snapshot.notifiedThresholds.push(threshold);
            continue;
          }
          snapshot.notifiedThresholds.push(threshold);
          if (threshold < 100) continue;
          if (hourInZone(input.now, this.config.sendShortfallTimezone) >= this.config.sendShortfallAfterHour) {
            continue;
          }
          await this.notify(
            formatFinishedMessage({ clientName, campaignName }),
            {
              key,
              campaignId: input.campaign.id,
              clientName,
              campaignName,
              kind: "completion",
              payload: { threshold, percent, ...stats },
            },
          );
          input.result.completion += 1;
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
            .catch(() => analytics),
        );
        const sentToday = todayVolume.sent || parseSentCount(analytics);
        const diagnosis = diagnoseSending({
          sent: sentToday,
          remaining: stats.remaining,
          schedule,
          inboxes,
          messagePerDay: this.config.messagePerDay,
        });
        input.digestRows.push({
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
          .catch(() => analytics),
      );
      input.digestRows.push({
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

export function resolveClientName(
  campaign: SmartleadCampaign,
  clientsById: Map<number, SmartleadClientRecord>,
  supabaseCampaigns: Map<number, CampaignNameRow>,
  registry: Map<number, string>,
): string {
  const supabaseRow = supabaseCampaigns.get(campaign.id);
  if (supabaseRow?.client_name?.trim()) return supabaseRow.client_name.trim();
  if (campaign.client_id && registry.get(campaign.client_id)) {
    return registry.get(campaign.client_id)!;
  }
  if (campaign.client_id && clientsById.get(campaign.client_id)) {
    return clientDisplayName(clientsById.get(campaign.client_id));
  }
  if (supabaseRow?.smartlead_client_id && registry.get(supabaseRow.smartlead_client_id)) {
    return registry.get(supabaseRow.smartlead_client_id)!;
  }
  return "Unknown client";
}
