import { apiRequest, sleep, type RequestOptions } from "../lib/http.js";
import { asRecordArray, asNumber, pickString, unwrap } from "../lib/parse.js";
import { catalogClientRecords, mergeClientRecords } from "../lib/owners.js";

const BASE_URL = "https://server.smartlead.ai/api/v1/";

/** Watchdog may START a bounce-protection hold. It must never PAUSE or STOP. */
export const FORBIDDEN_CAMPAIGN_STATUSES = ["PAUSED", "STOPPED"] as const;
export type ForbiddenCampaignStatus = (typeof FORBIDDEN_CAMPAIGN_STATUSES)[number];
export type SmartleadCampaignStatusWrite = "START" | ForbiddenCampaignStatus;

export class ForbiddenCampaignStatusError extends Error {
  readonly campaignId: number;
  readonly status: string;

  constructor(campaignId: number, status: string) {
    super(
      `[watchdog] refused Smartlead status change to ${status} for campaign ${campaignId}`,
    );
    this.name = "ForbiddenCampaignStatusError";
    this.campaignId = campaignId;
    this.status = status;
  }
}

export function isForbiddenCampaignStatus(status: string): boolean {
  const normalized = String(status ?? "").trim().toUpperCase();
  return normalized === "PAUSED" || normalized === "STOPPED";
}

/** Throws and logs when a caller asks to PAUSE or STOP a campaign. */
export function assertAllowedCampaignStatus(
  campaignId: number,
  status: string,
): "START" {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (isForbiddenCampaignStatus(normalized) || normalized !== "START") {
    const error = new ForbiddenCampaignStatusError(campaignId, normalized || "(empty)");
    console.error(error.message);
    throw error;
  }
  return "START";
}

export interface SmartleadCampaign {
  id: number;
  name: string;
  status: string;
  client_id?: number | null;
  /** Campaign tags (only returned with `include_tags=true`). Ownership = `sg-owner:<slug>`. */
  tags?: SmartleadTag[];
  [key: string]: unknown;
}

export interface SmartleadTag {
  tag_id?: number;
  tag_name: string;
  tag_color?: string | null;
}

/** Every campaign list / get call asks for tags: ownership lives only in sg-owner tags. */
export const INCLUDE_TAGS_QUERY = { include_tags: true } as const;

export interface SmartleadClientRecord {
  id: number;
  name?: string;
  logo?: string | null;
}

export interface SmartleadEmailAccount {
  id: number;
  from_email?: string;
  email?: string;
  username?: string;
  message_per_day?: number;
  max_email_per_day?: number;
  daily_sent_count?: number;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  minTimeToWaitInMins?: number;
  time_to_wait_in_mins?: number;
}

/** Default spacing between Smartlead calls: 500ms ≈ 120/min of the shared 200/min key. */
export const DEFAULT_SMARTLEAD_MIN_INTERVAL_MS = 500;

/** Retries per Smartlead call; each 429 waits out Retry-After (≤ ~65s). */
export const SMARTLEAD_RETRIES = 6;

export function smartleadMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SMARTLEAD_MIN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SMARTLEAD_MIN_INTERVAL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SMARTLEAD_MIN_INTERVAL_MS;
}

/**
 * Process-wide gate: every Smartlead call (all SmartleadClient instances)
 * starts at least SMARTLEAD_MIN_INTERVAL_MS after the previous one started.
 * One master key serves every SalesGlider tool and Smartlead caps the whole
 * account at 200 requests/min, so Watchdog must leave headroom.
 */
let nextSmartleadSlotAt = 0;
export async function throttleSmartlead(nowMs: () => number = Date.now): Promise<void> {
  const interval = smartleadMinIntervalMs();
  if (interval <= 0) return;
  const now = nowMs();
  const slot = Math.max(now, nextSmartleadSlotAt);
  nextSmartleadSlotAt = slot + interval;
  if (slot > now) await sleep(slot - now);
}

/** Test hook: forget the last reserved slot. */
export function resetSmartleadThrottle(): void {
  nextSmartleadSlotAt = 0;
}

/** Smartlead statuses whose sends count toward "sent today" (everything but drafts). */
export function isCountableCampaignStatus(status: unknown): boolean {
  const normalized = String(status ?? "").trim().toUpperCase();
  return normalized !== "" && normalized !== "DRAFTED" && normalized !== "DRAFT";
}

/** Smartlead: "Maximum 100 campaign IDs are allowed". */
export const MAX_DAY_WISE_CAMPAIGN_IDS = 100;

export interface DayWiseTotals {
  sent: number;
  bounced: number;
}

export class SmartleadClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await throttleSmartlead();
    return apiRequest<T>(BASE_URL, this.apiKey, path, {
      retries: SMARTLEAD_RETRIES,
      ...options,
    });
  }

  /**
   * Sent / bounced on `day` (YYYY-MM-DD) summed over `campaignIds`, in ONE
   * call (`GET analytics/day-wise-overall-stats`). Throws on an unexpected
   * shape — callers must never read a failure as 0 sent.
   */
  async getDayWiseTotals(day: string, campaignIds: number[]): Promise<DayWiseTotals> {
    if (!campaignIds.length) return { sent: 0, bounced: 0 };
    if (campaignIds.length > MAX_DAY_WISE_CAMPAIGN_IDS) {
      throw new Error(`day-wise-overall-stats: at most ${MAX_DAY_WISE_CAMPAIGN_IDS} campaign ids per call`);
    }
    const raw = await this.request<unknown>("analytics/day-wise-overall-stats", {
      query: { start_date: day, end_date: day, campaign_ids: campaignIds.join(",") },
    });
    const parsed = parseDayWiseTotals(raw);
    if (!parsed) throw new Error("day-wise-overall-stats: unexpected response shape");
    return parsed;
  }

  /** Whole-account sent / bounced on `day` (no campaign filter). Cross-checks only. */
  async getAccountDayWiseTotals(day: string): Promise<DayWiseTotals> {
    const raw = await this.request<unknown>("analytics/day-wise-overall-stats", {
      query: { start_date: day, end_date: day },
    });
    const parsed = parseDayWiseTotals(raw);
    if (!parsed) throw new Error("day-wise-overall-stats: unexpected response shape");
    return parsed;
  }

  async listCampaigns(): Promise<SmartleadCampaign[]> {
    const raw = await this.request<unknown>("campaigns/", {
      query: INCLUDE_TAGS_QUERY,
    });
    return asRecordArray(raw)
      .map(normalizeCampaign)
      .filter((row): row is SmartleadCampaign => row != null);
  }

  /**
   * Client directory. Smartlead spaces are deleted (`GET /client` returns []),
   * so this serves the owner catalog. The live call is kept only as an
   * optional merge in case it ever returns rows again; its failure is ignored.
   */
  async listClients(): Promise<SmartleadClientRecord[]> {
    const live = await this.request<unknown>("client/").catch(() => []);
    const liveRows = asRecordArray(live)
      .map((row) => ({
        id: asNumber(row.id) ?? NaN,
        name: pickString(row, ["name"]),
        logo: pickString(row, ["logo"]) ?? null,
      }))
      .filter((row) => Number.isFinite(row.id));
    return mergeClientRecords(catalogClientRecords(), liveRows);
  }

  getCampaign(campaignId: number): Promise<unknown> {
    return this.request(`campaigns/${campaignId}`, {
      query: INCLUDE_TAGS_QUERY,
    });
  }

  getCampaignSettings(campaignId: number): Promise<unknown> {
    return this.request(`campaigns/${campaignId}/settings`);
  }

  getCampaignAnalytics(campaignId: number): Promise<unknown> {
    return this.request(`campaigns/${campaignId}/analytics`);
  }

  getCampaignStatistics(campaignId: number): Promise<unknown> {
    return this.request(`campaigns/${campaignId}/statistics`);
  }

  /** Paged sent-email statistics. `total_stats` is the count; `data[].email_message` is the sent body. */
  getCampaignStatisticsPage(
    campaignId: number,
    query: {
      limit: number;
      offset?: number;
      sequenceNumber?: number;
      sentStartDate?: string;
      sentEndDate?: string;
    },
  ): Promise<unknown> {
    return this.request(`campaigns/${campaignId}/statistics`, {
      query: {
        offset: query.offset ?? 0,
        limit: query.limit,
        email_sequence_number: query.sequenceNumber,
        sent_time_start_date: query.sentStartDate,
        sent_time_end_date: query.sentEndDate,
      },
    });
  }

  getCampaignAnalyticsByDate(
    campaignId: number,
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    return this.request(`campaigns/${campaignId}/analytics-by-date`, {
      query: { start_date: startDate, end_date: endDate },
    });
  }

  async updateCampaignStatus(
    campaignId: number,
    status: SmartleadCampaignStatusWrite,
  ): Promise<unknown> {
    const allowed = assertAllowedCampaignStatus(campaignId, status);
    return this.request(`campaigns/${campaignId}/status`, {
      method: "POST",
      body: { status: allowed },
    });
  }

  async getCampaignEmailAccounts(campaignId: number): Promise<SmartleadEmailAccount[]> {
    const raw = await this.request<unknown>(`campaigns/${campaignId}/email-accounts`,
    );
    return asRecordArray(raw).map((row) => ({
      id: asNumber(row.id) ?? 0,
      from_email: pickString(row, ["from_email", "fromEmail"]),
      email: pickString(row, ["email"]),
      username: pickString(row, ["username"]),
      message_per_day: asNumber(row.message_per_day),
      max_email_per_day: asNumber(row.max_email_per_day),
      daily_sent_count: asNumber(row.daily_sent_count),
      is_smtp_success: row.is_smtp_success === false ? false : true,
      is_imap_success: row.is_imap_success === false ? false : true,
      minTimeToWaitInMins: asNumber(row.minTimeToWaitInMins),
      time_to_wait_in_mins: asNumber(row.time_to_wait_in_mins),
    }));
  }
}

export function clientDisplayName(client?: {
  name?: string | null;
  logo?: string | null;
  id?: number;
}): string {
  const logo = client?.logo?.trim();
  const name = client?.name?.trim();
  if (logo && name && logo.toLowerCase() !== name.toLowerCase()) {
    return `${logo} (${name})`;
  }
  return logo || name || (client?.id ? `Client ${client.id}` : "Unknown client");
}

export function inboxCountOf(accounts: SmartleadEmailAccount[]): number {
  return accounts.filter((account) => account.id > 0).length;
}

function normalizeCampaign(row: Record<string, unknown>): SmartleadCampaign | null {
  const root = unwrap(row) ?? row;
  const id = asNumber(root.id);
  const name = pickString(root, ["name", "campaign_name"]);
  if (id == null || !name) return null;
  return {
    ...(root as SmartleadCampaign),
    id,
    name,
    status: pickString(root, ["status"]) ?? "",
    client_id:
      asNumber(root.client_id) ??
      asNumber(root.clientId) ??
      asNumber(unwrap(root.client)?.id) ??
      null,
    tags: normalizeTags(root.tags),
  };
}

export function normalizeTags(raw: unknown): SmartleadTag[] {
  if (!Array.isArray(raw)) return [];
  const out: SmartleadTag[] = [];
  for (const tag of raw) {
    if (typeof tag === "string") {
      if (tag.trim()) out.push({ tag_name: tag.trim() });
      continue;
    }
    const row = unwrap(tag);
    const name = row ? pickString(row, ["tag_name", "name"]) : undefined;
    if (!row || !name) continue;
    out.push({
      tag_id: asNumber(row.tag_id ?? row.id),
      tag_name: name,
      tag_color: pickString(row, ["tag_color", "color"]) ?? null,
    });
  }
  return out;
}

export { sleep };

/**
 * `{ success, data: { day_wise_stats: [{ date, email_engagement_metrics: { sent, bounced } }] } }`
 * → summed sent/bounced. `null` when the shape is not recognised.
 */
export function parseDayWiseTotals(raw: unknown): DayWiseTotals | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as { success?: unknown; data?: unknown };
  if (root.success === false) return null;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null;
  const days = data?.day_wise_stats;
  if (!Array.isArray(days)) return null;
  let sent = 0;
  let bounced = 0;
  for (const day of days) {
    const metrics =
      day && typeof day === "object"
        ? (day as { email_engagement_metrics?: unknown }).email_engagement_metrics
        : null;
    if (!metrics || typeof metrics !== "object") return null;
    const m = metrics as Record<string, unknown>;
    const daySent = asNumber(m.sent);
    if (daySent == null) return null;
    sent += Math.max(0, daySent);
    bounced += Math.max(0, asNumber(m.bounced) ?? 0);
  }
  return { sent, bounced };
}
