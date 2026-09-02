import type { HeyReachWorkspaceConfig } from "../config.js";
import { apiRequest, sleep } from "../lib/http.js";
import { asNumber, asRecordArray, pickString, unwrap } from "../lib/parse.js";

export type { HeyReachWorkspaceConfig };

const BASE_URL = "https://api.heyreach.io/api/public/";

export interface HeyReachProgressStats {
  total: number;
  pending: number;
  inProgress: number;
  finished: number;
  failed: number;
}

export interface HeyReachCampaign {
  id: number;
  name: string;
  status: string;
  progressStats: HeyReachProgressStats | null;
}

export class HeyReachClient {
  constructor(
    readonly workspace: HeyReachWorkspaceConfig,
  ) {}

  async listCampaigns(statuses?: string[]): Promise<HeyReachCampaign[]> {
    const campaigns: HeyReachCampaign[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const raw = await this.request<unknown>("campaign/GetAll", {
        method: "POST",
        body: {
          offset,
          limit,
          ...(statuses?.length ? { statuses } : {}),
        },
      });
      const items = asRecordArray(raw).map(normalizeCampaign).filter((row): row is HeyReachCampaign => row != null);
      campaigns.push(...items);
      const root = unwrap(raw);
      const total = asNumber(root?.totalCount);
      offset += items.length;
      if (items.length < limit || (total != null && offset >= total)) break;
    }
    return campaigns;
  }

  getCampaign(campaignId: number): Promise<unknown> {
    return this.request("campaign/GetById", {
      method: "GET",
      query: { campaignId },
    });
  }

  getOverallStats(input: {
    campaignId: number;
    startDate: string;
    endDate: string;
  }): Promise<unknown> {
    return this.request("stats/GetOverallStats", {
      method: "POST",
      body: {
        accountIds: [],
        campaignIds: [input.campaignId],
        startDate: input.startDate,
        endDate: input.endDate,
        dateFrom: input.startDate,
        dateTo: input.endDate,
      },
    });
  }

  private request<T>(path: string, options: Parameters<typeof apiRequest>[3]): Promise<T> {
    return apiRequest<T>(BASE_URL, undefined, path, {
      ...options,
      headers: {
        "X-API-KEY": this.workspace.apiKey,
        Accept: "application/json",
        ...(options?.headers ?? {}),
      },
    });
  }
}

export function normalizeCampaign(row: Record<string, unknown>): HeyReachCampaign | null {
  const root = unwrap(row) ?? row;
  const id = asNumber(root.id);
  const name = pickString(root, ["name", "campaignName", "campaign_name"]);
  if (id == null || !name) return null;
  return {
    id,
    name,
    status: pickString(root, ["status"]) ?? "",
    progressStats: parseProgressStats(root.progressStats ?? root.progress_stats ?? root),
  };
}

export function parseProgressStats(raw: unknown): HeyReachProgressStats | null {
  const root = unwrap(raw);
  if (!root) return null;
  const total =
    asNumber(root.totalUsers) ??
    asNumber(root.total) ??
    asNumber(root.totalUsersCount);
  const pending =
    asNumber(root.totalUsersPending) ??
    asNumber(root.pending) ??
    asNumber(root.totalUsersPendingCount);
  const inProgress =
    asNumber(root.totalUsersInProgress) ??
    asNumber(root.inProgress) ??
    asNumber(root.in_progress);
  if (total == null && pending == null && inProgress == null) return null;
  return {
    total: total ?? (pending ?? 0) + (inProgress ?? 0),
    pending: pending ?? 0,
    inProgress: inProgress ?? 0,
    finished: asNumber(root.totalUsersFinished) ?? asNumber(root.finished) ?? 0,
    failed: asNumber(root.totalUsersFailed) ?? asNumber(root.failed) ?? 0,
  };
}

export { sleep };
