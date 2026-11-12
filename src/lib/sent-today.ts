import { clientGroupKey } from "./clients.js";
import { parseTodayVolume } from "./pulse.js";

/**
 * Exact per-client "sent today": one `analytics/day-wise-overall-stats` call
 * per client over ALL of its non-draft campaigns (ACTIVE, PAUSED, COMPLETED,
 * STOPPED — so lists that finish or stop mid-day still count). Replaces ~580
 * per-campaign `analytics-by-date` calls that 429'd on the shared 200/min key
 * and were then silently read as 0.
 *
 * If a client's bulk call fails, fall back to per-campaign by-date reads for
 * that client. A campaign whose read still fails is counted as *unread* —
 * never as 0 — so the line renders `≥N sent (incomplete: k campaigns unread)`.
 */

/** Smartlead rejects more than 100 ids per call ("Maximum 100 campaign IDs are allowed"). */
export const DAY_WISE_CHUNK_SIZE = 100;

export interface SentTodayCampaign {
  id: number;
  name?: string;
  clientId: number | null;
  clientName: string;
}

export interface ClientSentToday {
  clientId: number | null;
  clientName: string;
  sent: number;
  bounced: number;
  /** Campaigns counted for this client (non-draft, not muted). */
  campaigns: number;
  /** Campaigns whose sent-today could not be read; `sent` is then a floor. */
  unread: number;
}

export interface SentTodaySource {
  getDayWiseTotals(day: string, campaignIds: number[]): Promise<{ sent: number; bounced: number }>;
  getCampaignAnalyticsByDate(campaignId: number, startDate: string, endDate: string): Promise<unknown>;
}

export interface SentTodayResult {
  byKey: Map<string, ClientSentToday>;
  calls: number;
  /** Bulk (day-wise) chunks that failed and fell back to per-campaign reads. */
  bulkFailures: number;
}

export function groupCampaignsByClient(
  campaigns: SentTodayCampaign[],
): Map<string, { clientId: number | null; clientName: string; campaigns: SentTodayCampaign[] }> {
  const groups = new Map<
    string,
    { clientId: number | null; clientName: string; campaigns: SentTodayCampaign[] }
  >();
  for (const campaign of campaigns) {
    const key = clientGroupKey(campaign);
    const group = groups.get(key) ?? {
      clientId: campaign.clientId,
      clientName: campaign.clientName,
      campaigns: [],
    };
    group.campaigns.push(campaign);
    groups.set(key, group);
  }
  return groups;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function countSentTodayByClient(input: {
  source: SentTodaySource;
  day: string;
  campaigns: SentTodayCampaign[];
  chunkSize?: number;
  log?: (message: string) => void;
}): Promise<SentTodayResult> {
  const log = input.log ?? ((message: string) => console.warn(message));
  const chunkSize = Math.min(DAY_WISE_CHUNK_SIZE, Math.max(1, input.chunkSize ?? DAY_WISE_CHUNK_SIZE));
  const byKey = new Map<string, ClientSentToday>();
  let calls = 0;
  let bulkFailures = 0;

  for (const [key, group] of groupCampaignsByClient(input.campaigns)) {
    const row: ClientSentToday = {
      clientId: group.clientId,
      clientName: group.clientName,
      sent: 0,
      bounced: 0,
      campaigns: group.campaigns.length,
      unread: 0,
    };
    for (const part of chunk(group.campaigns, chunkSize)) {
      try {
        calls += 1;
        const totals = await input.source.getDayWiseTotals(
          input.day,
          part.map((campaign) => campaign.id),
        );
        row.sent += Math.max(0, totals.sent);
        row.bounced += Math.max(0, totals.bounced);
        continue;
      } catch (error) {
        bulkFailures += 1;
        log(
          `[watchdog] sent-today day-wise ${group.clientName} (${part.length} campaigns) failed: ${errorText(error)} — falling back to per-campaign reads`,
        );
      }
      for (const campaign of part) {
        try {
          calls += 1;
          const raw = await input.source.getCampaignAnalyticsByDate(
            campaign.id,
            input.day,
            input.day,
          );
          if (raw == null) throw new Error("empty response");
          const volume = parseTodayVolume(raw, input.day);
          row.sent += volume.sent;
          row.bounced += volume.bounced;
        } catch (error) {
          row.unread += 1;
          log(
            `[watchdog] sent-today #${campaign.id} ${campaign.name ?? ""} unread (${group.clientName}): ${errorText(error)}`,
          );
        }
      }
    }
    byKey.set(key, row);
  }
  return { byKey, calls, bulkFailures };
}

export { formatSentCount } from "./pulse.js";
