import { apiRequest, sleep } from "../lib/http.js";
import { asRecordArray, asNumber, pickString, unwrap } from "../lib/parse.js";

const BASE_URL = "https://server.smartlead.ai/api/v1/";

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

export class SmartleadClient {
  constructor(private readonly apiKey: string) {}

  async listCampaigns(): Promise<SmartleadCampaign[]> {
    const raw = await apiRequest<unknown>(BASE_URL, this.apiKey, "campaigns/");
    return asRecordArray(raw)
      .map(normalizeCampaign)
      .filter((row): row is SmartleadCampaign => row != null);
  }

  listClients(): Promise<SmartleadClientRecord[]> {
    return apiRequest<SmartleadClientRecord[]>(BASE_URL, this.apiKey, "client/");
  }

  getCampaign(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}`);
  }

  getCampaignSettings(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/settings`);
  }

  getCampaignAnalytics(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/analytics`);
  }

  getCampaignStatistics(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/statistics`);
  }

  getCampaignAnalyticsByDate(
    campaignId: number,
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/analytics-by-date`, {
      query: { start_date: startDate, end_date: endDate },
    });
  }

  updateCampaignStatus(
    campaignId: number,
    status: "START" | "PAUSED" | "STOPPED",
  ): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/status`, {
      method: "POST",
      body: { status },
    });
  }

  async getCampaignEmailAccounts(campaignId: number): Promise<SmartleadEmailAccount[]> {
    const raw = await apiRequest<unknown>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}/email-accounts`,
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
  };
}

export { sleep };
