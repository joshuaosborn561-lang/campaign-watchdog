import { shortCampaignName, isNoiseCampaign } from "./names.js";

export type LaneKind = "dry" | "low";

export interface LeadLane {
  id: number;
  name: string;
  clientId: number | null;
  clientName: string;
  notStarted: number;
  inProgress: number;
  /** First-touch (sequence 1) sends per day over the recent weekday window. */
  perDay: number | null;
  daysLeft: number | null;
}

/** Campaigns the leads check never reports. Mirrors the routine's skip list. */
export const DEFAULT_LEADS_SKIP_IDS = [
  3977481, 3977483, 3977484, 3977485, // Staffing CANDIDATES
  3969268, // PE Thesis SEG
  4085158, 4085159, 4085160, // Gabe call campaigns
  4049046, 4049047, 4049048, 4049049, 4049050, 4049051, 4049052, 4049053, 4049054, 4049055,
  4049056, 4049057, 4049058, 4049059, 4049060, 4049061, 4049062, 4049063, 4049064, 4049065, // superseded Parlay Choice
  4099156, // old SG influencer (completed)
];
/** Vasco (retired) and Goliath (no live sending). */
export const DEFAULT_LEADS_SKIP_CLIENT_IDS = [548609, 548611];
/** BCP Logistics IT is dead and never gets a refill. */
export const DEFAULT_LEADS_SKIP_NAME_PATTERNS = ["logistics it"];

export interface LeadsSkipRules {
  ids: Iterable<number>;
  clientIds: Iterable<number>;
  namePatterns: string[];
}

export function leadsSkipReason(
  campaign: { id: number; name: string; clientId: number | null },
  rules: LeadsSkipRules,
): string | null {
  if (campaign.clientId == null) return "no client";
  if (isNoiseCampaign(campaign.name)) return "noise";
  if (new Set(rules.ids).has(campaign.id)) return "skip id";
  if (new Set(rules.clientIds).has(campaign.clientId)) return "skip client";
  const lower = campaign.name.toLowerCase();
  if (rules.namePatterns.some((pattern) => pattern && lower.includes(pattern.toLowerCase()))) {
    return "skip name";
  }
  return null;
}

export function daysLeftOf(notStarted: number, perDay: number | null): number | null {
  if (perDay == null || perDay <= 0) return null;
  return Math.round((notStarted / perDay) * 10) / 10;
}

/** `dry` = no new leads left. `low` = fewer than `lowDays` of first touches left. */
export function classifyLane(lane: LeadLane, lowDays: number): LaneKind | null {
  if (lane.notStarted <= 0) return "dry";
  if (lane.daysLeft != null && lane.daysLeft < lowDays) return "low";
  return null;
}

export interface LeadAlertEntry {
  kind: LaneKind;
  alertedAt: string;
}

/**
 * Exceptions only. A lane alerts when it first goes dry/low, when low turns into dry,
 * or once more every `remindHours` while it stays flagged. Recovered lanes drop out of
 * state so the next time they go dry they alert again.
 */
export function decideLeadAlerts(
  flagged: Array<{ lane: LeadLane; kind: LaneKind }>,
  prior: Record<string, LeadAlertEntry>,
  now: Date,
  remindHours: number,
): { toAlert: Array<{ lane: LeadLane; kind: LaneKind }>; next: Record<string, LeadAlertEntry> } {
  const next: Record<string, LeadAlertEntry> = {};
  const toAlert: Array<{ lane: LeadLane; kind: LaneKind }> = [];
  for (const item of flagged) {
    const key = String(item.lane.id);
    const before = prior[key];
    const age = before ? now.getTime() - Date.parse(before.alertedAt) : Infinity;
    const escalated = before != null && before.kind === "low" && item.kind === "dry";
    const due = !before || escalated || !(age < remindHours * 3_600_000);
    if (due) {
      toAlert.push(item);
      next[key] = { kind: item.kind, alertedAt: now.toISOString() };
    } else {
      next[key] = { kind: item.kind, alertedAt: before.alertedAt };
    }
  }
  return { toAlert, next };
}

export interface DoubleSigResult {
  id: number;
  name: string;
  clientName: string;
  sampled: number;
  doubles: number;
  lastDoubleSentAt: string | null;
}

export interface DoubleSigEntry {
  status: "open" | "cleared";
  firstFlagged: string;
  lastDoubleSentAt: string | null;
}

/**
 * Alert once per campaign when a double signature first shows up (or comes back after
 * being cleared). A campaign clears silently once recent sends are sampled and clean.
 */
export function decideDoubleSigAlerts(
  results: DoubleSigResult[],
  prior: Record<string, DoubleSigEntry>,
  now: Date,
): { toAlert: DoubleSigResult[]; next: Record<string, DoubleSigEntry> } {
  const next: Record<string, DoubleSigEntry> = { ...prior };
  const toAlert: DoubleSigResult[] = [];
  for (const result of results) {
    const key = String(result.id);
    const before = prior[key];
    if (result.doubles > 0) {
      if (!before || before.status === "cleared") {
        toAlert.push(result);
        next[key] = {
          status: "open",
          firstFlagged: now.toISOString(),
          lastDoubleSentAt: result.lastDoubleSentAt,
        };
      } else {
        next[key] = { ...before, lastDoubleSentAt: result.lastDoubleSentAt ?? before.lastDoubleSentAt };
      }
    } else if (result.sampled > 0 && before?.status === "open") {
      next[key] = { ...before, status: "cleared" };
    }
  }
  return { toAlert, next };
}

function namesPhrase(names: string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

export function formatLeadsAlert(input: {
  header: string;
  lanes: Array<{ lane: LeadLane; kind: LaneKind }>;
  doubleSigs: DoubleSigResult[];
  lowDays: number;
}): string | null {
  if (!input.lanes.length && !input.doubleSigs.length) return null;
  const lines: string[] = [`*${input.header}*`];
  const byClient = new Map<string, Array<{ lane: LeadLane; kind: LaneKind }>>();
  for (const item of input.lanes) {
    const list = byClient.get(item.lane.clientName) ?? [];
    list.push(item);
    byClient.set(item.lane.clientName, list);
  }
  for (const [client, items] of [...byClient.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dry = items.filter((item) => item.kind === "dry");
    const low = items.filter((item) => item.kind === "low");
    const parts: string[] = [];
    if (dry.length) {
      parts.push(
        `${dry.length} out of leads (${namesPhrase(dry.map((item) => shortCampaignName(client, item.lane.name)))})`,
      );
    }
    if (low.length) {
      parts.push(
        `${low.length} under ${input.lowDays} days (${namesPhrase(
          low.map((item) => `${shortCampaignName(client, item.lane.name)} ${item.lane.daysLeft}d`),
        )})`,
      );
    }
    lines.push(`• *${client}* — ${parts.join(" · ")}`);
  }
  for (const sig of input.doubleSigs) {
    lines.push(
      `• *${sig.clientName}* — *${shortCampaignName(sig.clientName, sig.name)}* \`#${sig.id}\` double signature (${sig.doubles}/${sig.sampled} recent sends)`,
    );
  }
  return lines.join("\n");
}

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isWeekendYmd(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Smartlead date window covering the last `weekdays` weekdays up to and including `today`
 * (a Chicago YYYY-MM-DD). `end` is tomorrow so today's sends are included.
 */
export function weekdayWindow(
  today: string,
  weekdays: number,
): { start: string; end: string; weekdays: number } {
  let cursor = today;
  let found = isWeekendYmd(cursor) ? 0 : 1;
  let start = isWeekendYmd(cursor) ? "" : cursor;
  while (found < weekdays) {
    cursor = shiftYmd(cursor, -1);
    if (isWeekendYmd(cursor)) continue;
    found += 1;
    start = cursor;
  }
  return { start: start || today, end: shiftYmd(today, 1), weekdays };
}
