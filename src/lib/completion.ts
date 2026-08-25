import { asNumber, pickNumber, unwrap } from "./parse.js";

export interface CampaignLeadStats {
  total: number;
  contacted: number;
  remaining: number;
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
    pickNumber(leadStats ?? {}, ["notStarted", "not_started", "drafted", "drafted_count"]) ??
    pickNumber(root, ["drafted_count", "drafted", "not_started", "leads_not_started"]);
  const contacted =
    pickNumber(root, ["contacted", "leads_contacted", "contacted_count", "unique_sent_count"]) ??
    (total != null && notStarted != null ? Math.max(0, total - notStarted) : undefined);
  if (total == null || total <= 0) return null;

  const remaining =
    notStarted ??
    (contacted != null ? Math.max(0, total - contacted) : undefined);
  if (remaining == null) return null;

  return {
    total,
    contacted: contacted ?? Math.max(0, total - remaining),
    remaining,
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
