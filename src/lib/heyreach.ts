import { pickNumber, unwrap } from "./parse.js";

export const DEFAULT_HEYREACH_EXCLUDE_IDS = [530529];
export const DEFAULT_HEYREACH_RUNWAY_DAYS = 7;

export interface HeyReachInventory {
  campaignId: number;
  campaignName: string;
  status: string;
  pending: number;
  inProgress: number;
  remaining: number;
  total: number;
  weekdayPace: number | null;
  weekdaySamples: number;
  runwayDays: number | null;
}

export interface HeyReachAlertFlags {
  under7: boolean;
  pendingDry: boolean;
  excluded: boolean;
}

export function heyreachRemaining(stats: { pending: number; inProgress: number }): number {
  return Math.max(0, stats.pending + stats.inProgress);
}

export function isHeyReachExcluded(
  campaignId: number,
  excludeIds: number[] = DEFAULT_HEYREACH_EXCLUDE_IDS,
): boolean {
  return excludeIds.includes(campaignId);
}

export function heyreachAlertFlags(
  inventory: Pick<HeyReachInventory, "campaignId" | "status" | "pending" | "runwayDays">,
  options: { excludeIds?: number[]; runwayDays?: number } = {},
): HeyReachAlertFlags {
  const excludeIds = options.excludeIds ?? DEFAULT_HEYREACH_EXCLUDE_IDS;
  const limit = options.runwayDays ?? DEFAULT_HEYREACH_RUNWAY_DAYS;
  const excluded = isHeyReachExcluded(inventory.campaignId, excludeIds);
  const inProgress = String(inventory.status ?? "").toUpperCase() === "IN_PROGRESS";
  if (!inProgress || excluded) {
    return { under7: false, pendingDry: false, excluded };
  }
  const under7 = inventory.runwayDays != null && inventory.runwayDays < limit;
  const pendingDry = inventory.pending <= 0;
  return { under7, pendingDry, excluded };
}

export function shouldAlertHeyReach(flags: HeyReachAlertFlags): boolean {
  return !flags.excluded && (flags.under7 || flags.pendingDry);
}

/** Weekday average of connectionsSent + messagesSent from GetOverallStats. */
export function weekdayPaceFromStats(
  raw: unknown,
  weekdays: number[] = [1, 2, 3, 4, 5],
): { pace: number | null; samples: number } {
  const days = dailyStatRows(raw);
  if (!days.length) return { pace: null, samples: 0 };
  const allowed = new Set(weekdays);
  let sent = 0;
  let samples = 0;
  for (const day of days) {
    if (!allowed.has(weekdayOfYmd(day.date))) continue;
    sent += day.connectionsSent + day.messagesSent;
    samples += 1;
  }
  if (!samples) return { pace: null, samples: 0 };
  return { pace: sent / samples, samples };
}

export function runwayDays(remaining: number, weekdayPace: number | null): number | null {
  if (weekdayPace == null || weekdayPace <= 0) return null;
  return remaining / weekdayPace;
}

export function formatRunwayDays(days: number | null): string {
  if (days == null || !Number.isFinite(days)) return "unknown";
  if (days >= 10) return `~${Math.round(days)}d`;
  const tenths = Math.round(days * 10) / 10;
  return Number.isInteger(tenths) ? `~${tenths}d` : `~${tenths.toFixed(1)}d`;
}

export function formatHeyReachRunwayMessage(input: {
  clientName: string;
  campaignName: string;
  remaining: number;
  pending: number;
  inProgress: number;
  runwayDays: number | null;
  under7: boolean;
  pendingDry: boolean;
}): string {
  const who = `*${input.clientName}* — *${input.campaignName}*`;
  const left = `${input.remaining.toLocaleString()} left`;
  if (input.under7 && input.pendingDry) {
    return `${who} is nearly done (${formatRunwayDays(input.runwayDays)} LinkedIn runway, ${left}, 0 pending). Refill soon.`;
  }
  if (input.under7) {
    return `${who} is nearly done (${formatRunwayDays(input.runwayDays)} LinkedIn runway, ${left}). Refill soon.`;
  }
  const inProg =
    input.inProgress > 0 ? `, ${input.inProgress.toLocaleString()} in progress` : "";
  return `${who} is pending dry (0 new starts, still IN_PROGRESS${inProg}). Refill soon.`;
}

export function heyreachAlertKey(
  kind: "under7" | "pending-dry",
  campaignId: number,
): string {
  return `heyreach:${kind}:v1:${campaignId}`;
}

interface DailyStat {
  date: string;
  connectionsSent: number;
  messagesSent: number;
}

function dailyStatRows(raw: unknown): DailyStat[] {
  const root = unwrap(raw);
  if (!root) return [];
  const byDay = root.byDayStats ?? root.by_day_stats ?? root.dailyStats ?? root.daily;
  if (byDay && typeof byDay === "object" && !Array.isArray(byDay)) {
    return Object.entries(byDay as Record<string, unknown>).flatMap(([date, value]) => {
      const row = daySent(value);
      return row ? [{ date: normalizeDay(date), ...row }] : [];
    });
  }
  if (Array.isArray(byDay)) {
    return byDay.flatMap((value) => {
      const record = unwrap(value);
      if (!record) return [];
      const date = typeof record.date === "string" ? normalizeDay(record.date) : "";
      const row = daySent(record);
      return date && row ? [{ date, ...row }] : [];
    });
  }
  return [];
}

function daySent(raw: unknown): { connectionsSent: number; messagesSent: number } | null {
  const root = unwrap(raw);
  if (!root) return null;
  return {
    connectionsSent:
      pickNumber(root, ["connectionsSent", "connections_sent", "connectionRequestsSent"]) ?? 0,
    messagesSent: pickNumber(root, ["messagesSent", "messages_sent", "totalMessagesSent"]) ?? 0,
  };
}

function normalizeDay(value: string): string {
  return value.slice(0, 10);
}

function weekdayOfYmd(ymd: string): number {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) return -1;
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

export function addUtcDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isoDayStart(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export function isoDayEnd(ymd: string): string {
  return `${ymd}T23:59:59.999Z`;
}
