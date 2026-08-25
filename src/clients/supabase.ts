export interface CampaignNameRow {
  smartlead_campaign_id: number;
  name: string | null;
  client_name: string | null;
  smartlead_client_id: number | null;
}

export interface ClientRegistryRow {
  client_name: string;
  smartlead_client_id: number | null;
}

export class SupabaseStore {
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
  ) {}

  enabled(): boolean {
    return Boolean(this.url && this.serviceRoleKey);
  }

  async fetchCampaignNames(): Promise<Map<number, CampaignNameRow>> {
    const rows = await this.select<CampaignNameRow>(
      "campaigns",
      "smartlead_campaign_id,name,client_name,smartlead_client_id",
    );
    const map = new Map<number, CampaignNameRow>();
    for (const row of rows) {
      if (row.smartlead_campaign_id) map.set(Number(row.smartlead_campaign_id), row);
    }
    return map;
  }

  async fetchClientRegistry(): Promise<Map<number, string>> {
    const rows = await this.rpcOrSelect();
    const map = new Map<number, string>();
    for (const row of rows) {
      if (row.smartlead_client_id && row.client_name) {
        map.set(Number(row.smartlead_client_id), row.client_name);
      }
    }
    return map;
  }

  async hasAlert(key: string): Promise<boolean> {
    const rows = await this.select<{ alert_key: string }>(
      "campaign_watchdog_alerts",
      "alert_key",
      `alert_key=eq.${encodeURIComponent(key)}`,
    );
    return rows.length > 0;
  }

  async markAlert(input: {
    key: string;
    campaignId: number;
    clientName: string;
    campaignName: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.request("campaign_watchdog_alerts", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        alert_key: input.key,
        campaign_id: input.campaignId,
        client_name: input.clientName,
        campaign_name: input.campaignName,
        kind: input.kind,
        payload: input.payload,
      }),
    });
  }

  async readSlackTokens(): Promise<{ access_token?: string; refresh_token?: string } | null> {
    const rows = await this.select<{
      access_token?: string;
      refresh_token?: string;
    }>("campaign_watchdog_secrets", "access_token,refresh_token", "id=eq.slack");
    return rows[0] ?? null;
  }

  async writeSlackTokens(input: {
    accessToken: string;
    refreshToken?: string;
  }): Promise<void> {
    await this.request("campaign_watchdog_secrets", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: "slack",
        access_token: input.accessToken,
        refresh_token: input.refreshToken ?? null,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  private async rpcOrSelect(): Promise<ClientRegistryRow[]> {
    try {
      return await this.select<ClientRegistryRow>(
        "client_registry",
        "client_name,smartlead_client_id",
        undefined,
        "_meta",
      );
    } catch {
      return [];
    }
  }

  private async select<T>(
    table: string,
    columns: string,
    filter?: string,
    schema = "public",
  ): Promise<T[]> {
    const query = new URLSearchParams({ select: columns });
    const suffix = filter ? `&${filter}` : "";
    const response = await this.request(`${table}?${query.toString()}${suffix}`, {
      method: "GET",
      schema,
    });
    if (!response) return [];
    const json = (await response.json()) as T[] | { message?: string };
    if (!Array.isArray(json)) return [];
    return json;
  }

  private async request(
    path: string,
    options: {
      method: string;
      body?: string;
      headers?: Record<string, string>;
      schema?: string;
    },
  ): Promise<Response | null> {
    if (!this.enabled()) return null;
    const schema = options.schema ?? "public";
    const response = await fetch(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      method: options.method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Profile": schema,
        "Content-Profile": schema,
        ...options.headers,
      },
      body: options.body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase ${options.method} ${path} failed: ${response.status} ${text}`);
    }
    return response;
  }
}
