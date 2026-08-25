import type { AppConfig } from "../config.js";
import {
  SmartleadClient,
  clientDisplayName,
  inboxCountOf,
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
import {
  formatAutobounceMessage,
  formatCompletionMessage,
  formatSendingMessage,
} from "../lib/messages.js";
import { sendingShortfall, shouldCheckSending } from "../lib/sending.js";
import { hourInZone, isWeekendInZone, ymdInZone } from "../lib/time.js";
import type { StateStore } from "../state/store.js";

export interface WatchResult {
  scanned: number;
  completion: number;
  autobounce: number;
  sending: number;
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
      errors: [],
    };

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
    const hour = hourInZone(now, this.config.sendShortfallTimezone);
    const weekend = isWeekendInZone(now, this.config.sendShortfallTimezone);
    const checkSending = shouldCheckSending({
      hour,
      afterHour: this.config.sendShortfallAfterHour,
      weekend,
    });

    for (const campaign of campaigns) {
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
          checkSending,
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

  private async inspectCampaign(input: {
    campaign: SmartleadCampaign;
    status: string;
    clientsById: Map<number, SmartleadClientRecord>;
    supabaseCampaigns: Map<number, CampaignNameRow>;
    registry: Map<number, string>;
    day: string;
    checkSending: boolean;
    result: WatchResult;
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
      parseCampaignLeadStats(statistics) ??
      parseCampaignLeadStats(detail) ??
      parseCampaignLeadStats(analytics);

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
          await this.notify(
            formatCompletionMessage({
              clientName,
              campaignName,
              threshold,
              percent,
              contacted: stats.contacted,
              total: stats.total,
              remaining: stats.remaining,
            }),
            {
              key,
              campaignId: input.campaign.id,
              clientName,
              campaignName,
              kind: "completion",
              payload: { threshold, percent, ...stats },
            },
          );
          snapshot.notifiedThresholds.push(threshold);
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
    const becamePaused = snapshot.status !== "PAUSED" && verdict.paused;
    const shouldAlertAutobounce =
      verdict.autobounce &&
      ((firstSeen && this.config.alertExistingAutobounce) || becamePaused);
    if (shouldAlertAutobounce) {
      const key = `autobounce:v1:${input.campaign.id}:${input.day}`;
      if (!(await this.alreadySent(key))) {
        await this.notify(
          formatAutobounceMessage({ clientName, campaignName, verdict }),
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

    if (input.status === "ACTIVE" && input.checkSending) {
      const accounts = await this.smartlead.getCampaignEmailAccounts(input.campaign.id);
      const inboxes = inboxCountOf(accounts);
      const sentToday = parseSentCount(
        await this.smartlead
          .getCampaignAnalyticsByDate(input.campaign.id, input.day, input.day)
          .catch(() => analytics),
      );
      const shortfall = sendingShortfall({
        inboxCount: inboxes,
        sent: sentToday,
        perInboxTarget: this.config.messagePerDay,
      });
      if (shortfall && snapshot.lastSendingAlertDay !== input.day) {
        const key = `sending:v1:${input.campaign.id}:${input.day}`;
        if (!(await this.alreadySent(key))) {
          await this.notify(
            formatSendingMessage({
              clientName,
              campaignName,
              day: input.day,
              shortfall,
            }),
            {
              key,
              campaignId: input.campaign.id,
              clientName,
              campaignName,
              kind: "sending",
              payload: { day: input.day, ...shortfall },
            },
          );
          snapshot.lastSendingAlertDay = input.day;
          input.result.sending += 1;
        }
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
