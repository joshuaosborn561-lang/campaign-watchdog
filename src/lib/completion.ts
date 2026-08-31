import { asNumber, pickNumber, unwrap } from "./parse.js";

export interface CampaignLeadStats {
  total: number;
  contacted: number;
  remaining: number;
  notStarted: number;
  inProgress: number;
  replied: number;
  bounced: number;
  sent: number;
}

export function parseCampaignLeadStats(raw: unknown): CampaignLeadStats | null {
  const root = unwrap(raw);
  if (!root) return null;

  const leadStats = unwrap(
    root.campaign_lead_stats ?? root.campaignLeadStats ?? root.lead_stats,
  );
  const total =
    pickNumber(root, ["total_leads", "totalLeads", "total_count"]) ??
    pickNumber(leadStats ?? {}, ["total", "total_leads"]);
  const notStarted =
    pickNumber(leadStats ?? {}, ["notStarted", "not_started"]) ??
    pickNumber(root, ["not_started", "leads_not_started"]);
  const inProgress = pickNumber(leadStats ?? {}, [
    "inprogress",
    "in_progress",
    "inProgress",
  ]);
  const drafted = pickNumber(root, ["drafted_count", "drafted"]);
  const contacted = pickNumber(root, [
    "contacted",
    "leads_contacted",
    "contacted_count",
    "unique_sent_count",
  ]);
  if (total == null || total <= 0) return null;

  // notStarted is only new leads. Follow-ups sit in inprogress. drafted_count
  // is often total-sent and overstates what can still send.
  const remaining =
    notStarted != null || inProgress != null
      ? Math.max(0, (notStarted ?? 0) + (inProgress ?? 0))
      : drafted ??
        (contacted != null ? Math.max(0, total - contacted) : undefined);
  if (remaining == null) return null;

  return {
    total,
    contacted: contacted ?? Math.max(0, total - remaining),
    remaining,
    notStarted: notStarted ?? 0,
    inProgress: inProgress ?? 0,
    replied: pickNumber(root, ["replied", "leads_replied", "reply_count"]) ?? 0,
    bounced: pickNumber(root, ["bounced", "bounce_count", "total_bounced"]) ?? 0,
    sent: pickNumber(root, ["sent", "sent_count", "total_sent", "leads_contacted"]) ?? 0,
  };
}

export function completionPercent(stats: CampaignLeadStats): number {
  if (stats.total <= 0) return 0;
  return ((stats.total - stats.remaining) / stats.total) * 100;
}

export function thresholdsReached(
  percent: number,
  thresholds: number[],
): number[] {
  const sorted = [...thresholds].sort((a, b) => a - b);
  return sorted.filter((threshold) => {
    if (threshold >= 100) return percent >= 99.5;
    return percent + 1e-9 >= threshold;
  });
}

export function newThresholds(
  percent: number,
  alreadyNotified: number[],
  thresholds: number[],
): number[] {
  const reached = thresholdsReached(percent, thresholds);
  const seen = new Set(alreadyNotified);
  return reached.filter((threshold) => !seen.has(threshold));
}

/** 50% is tracked in state but never Slacked — too early for a refill. */
export const SLACK_COMPLETION_THRESHOLDS = [75, 90, 100] as const;

/**
 * Thresholds to Slack on this pass. Never 50%. Never 75/90 if the
 * campaign is already finished (100%) on the same observation.
 */
export function completionAlertsToPost(fresh: number[], percent: number): number[] {
  const finished = percent >= 99.5 || fresh.includes(100);
  return fresh.filter((threshold) => {
    if (threshold !== 75 && threshold !== 90 && threshold !== 100) return false;
    if (threshold < 100 && finished) return false;
    return true;
  });
}

export interface ClientCampaignLeadRow {
  id: number;
  clientId?: number | null;
  clientName: string;
  campaignName: string;
  status: string;
  remaining: number | null;
}

/**
 * True if this client still has another ACTIVE, non-noise, non-Generic
 * campaign that can send. Unknown remaining is treated as still sending
 * so we do not cry refill while a sibling scan failed.
 */
export function clientHasOtherActiveLeads(
  finishing: { id: number; clientId?: number | null; clientName: string },
  rows: ClientCampaignLeadRow[],
  isIgnored: (campaignName: string) => boolean,
): boolean {
  return rows.some((row) => {
    if (row.id === finishing.id) return false;
    if (String(row.status ?? "").toUpperCase() !== "ACTIVE") return false;
    if (isIgnored(row.campaignName)) return false;
    const sameClient =
      finishing.clientId != null && row.clientId != null
        ? finishing.clientId === row.clientId
        : row.clientName === finishing.clientName;
    if (!sameClient) return false;
    return row.remaining == null || row.remaining > 0;
  });
}

export function parseSentCount(raw: unknown): number {
  if (typeof raw === "number") return asNumber(raw) ?? 0;
  if (Array.isArray(raw)) {
    return raw.reduce((sum, row) => sum + parseSentCount(row), 0);
  }
  const root = unwrap(raw);
  if (!root) return 0;
  for (const key of ["data", "result", "analytics", "days"]) {
    const nested = root[key];
    if (Array.isArray(nested)) return parseSentCount(nested);
  }
  return pickNumber(root, ["sent_count", "sent", "total_sent", "emails_sent"]) ?? 0;
}
