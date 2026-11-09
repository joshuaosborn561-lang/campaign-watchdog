import { ApiError, apiRequest, sleep, type RequestOptions } from "../lib/http.js";
import { asRecordArray, asNumber, pickString, unwrap } from "../lib/parse.js";
import { SmartleadLimiter } from "../lib/smartlead-limiter.js";

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
  [key: string]: unknown;
}

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

export interface SmartleadClientOptions {
  limiter?: SmartleadLimiter;
  /** Account-wide cap is 200/min. Wizard already uses ~150. Default leaves headroom. */
  maxPerMinute?: number;
  concurrency?: number;
  minGapMs?: number;
  /** Extra attempts after the first. 429s wait on Retry-After before the next try. */
  maxRetries?: number;
}

export class SmartleadClient {
  private readonly limiter: SmartleadLimiter;
  private readonly maxRetries: number;
  /** Successful GETs reused for the current watch or pulse pass. */
  private memo: Map<string, Promise<unknown>> | null = null;

  constructor(
    private readonly apiKey: string,
    options: SmartleadClientOptions = {},
  ) {
    this.limiter =
      options.limiter ??
      new SmartleadLimiter({
        maxPerMinute: options.maxPerMinute,
        concurrency: options.concurrency,
        minGapMs: options.minGapMs,
      });
    this.maxRetries = options.maxRetries ?? 4;
  }

  /** Collapse duplicate GETs inside one pass (resume + pulse both read analytics). */
  beginReadMemo(): void {
    this.memo = new Map();
  }

  endReadMemo(): void {
    this.memo = null;
  }

  async listCampaigns(): Promise<SmartleadCampaign[]> {
    const raw = await this.request<unknown>("campaigns/");
    return asRecordArray(raw)
      .map(normalizeCampaign)
      .filter((row): row is SmartleadCampaign => row != null);
  }

  listClients(): Promise<SmartleadClientRecord[]> {
    return this.request<SmartleadClientRecord[]>("client/");
  }

  getCampaign(campaignId: number): Promise<unknown> {
    return this.request(`campaigns/${campaignId}`);
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
    const raw = await this.request<unknown>(`campaigns/${campaignId}/email-accounts`);
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

  private request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    if (method !== "GET" || !this.memo) return this.requestOnce<T>(path, options);
    const key = `${method} ${path} ${JSON.stringify(options.query ?? {})}`;
    const hit = this.memo.get(key);
    if (hit) return hit as Promise<T>;
    const pending = this.requestOnce<T>(path, options);
    this.memo.set(key, pending);
    pending.catch(() => {
      if (this.memo?.get(key) === pending) this.memo.delete(key);
    });
    return pending;
  }

  /**
   * One logical Smartlead call. The limiter spaces starts. A 429 pauses the
   * limiter (Retry-After when present) and is tried again. Other 4xx are not
   * retried. The slot is released before the pause so waiters share it.
   */
  private async requestOnce<T>(path: string, options: RequestOptions): Promise<T> {
    const retries = options.retries ?? this.maxRetries;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.limiter.schedule(() =>
          apiRequest<T>(BASE_URL, this.apiKey, path, { ...options, retries: 0 }),
        );
      } catch (error) {
        last = error;
        const status = error instanceof ApiError ? error.status : 0;
        const retryable = status === 0 || status === 429 || status >= 500;
        if (!retryable || attempt >= retries) break;
        if (status === 429) {
          this.limiter.noteRateLimit(error instanceof ApiError ? error.retryAfterMs : undefined);
        } else {
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
        }
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
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
  };
}

export { sleep };
