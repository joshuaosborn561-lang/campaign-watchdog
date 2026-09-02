import { clientGroupKey } from "./clients.js";
import { isNoiseCampaign, shortCampaignName } from "./names.js";
import { pickNumber, pickString, unwrap } from "./parse.js";
import { hourInZone, minutesInZone, weekdayInZone, ymdInZone } from "./time.js";

export interface ClientPulse {
  clientId?: number | null;
  clientName: string;
  sent: number;
  bounced: number;
}

export interface PausedPulseRow {
  clientName: string;
  campaignName: string;
}

/** Every still-paused real campaign, including ones left paused on purpose (e.g. Generic). */
export function stillPausedCampaigns<T extends { name: string; status: string }>(
  campaigns: T[],
): T[] {
  return campaigns.filter(
    (campaign) =>
      String(campaign.status ?? "").toUpperCase() === "PAUSED" &&
      !isNoiseCampaign(campaign.name),
  );
}

export function rollupClientPulse(
  rows: Array<{ clientId?: number | null; clientName: string; sent: number; bounced: number }>,
): ClientPulse[] {
  const groups = new Map<string, ClientPulse>();
  for (const row of rows) {
    const key = clientGroupKey(row);
    const current = groups.get(key) ?? {
      clientId: row.clientId ?? null,
      clientName: row.clientName,
      sent: 0,
      bounced: 0,
    };
    current.sent += Math.max(0, row.sent);
    current.bounced += Math.max(0, row.bounced);
    groups.set(key, current);
  }
  return [...groups.values()].sort(
    (a, b) => b.sent - a.sent || a.clientName.localeCompare(b.clientName),
  );
}

export function bouncePercent(sent: number, bounced: number): number | null {
  if (sent <= 0) return null;
  return (bounced / sent) * 100;
}

/**
 * Day sent/bounce for one campaign. Never treat lifetime `sent_count` as
 * today when a dated row (or empty day array) is present — that is how
 * BCP Healthcare 0-send days were reported as 5k+ lifetime follow-ups.
 */
export function parseTodayVolume(
  raw: unknown,
  day?: string,
): { sent: number; bounced: number } {
  const root = unwrap(raw);
  if (!root) return { sent: 0, bounced: 0 };

  const dated = datedVolumeRows(root);
  if (dated.present) {
    if (day) {
      const matched = dated.rows.filter((row) => !row.date || row.date === day);
      const hasDated = dated.rows.some((row) => row.date);
      if (hasDated && !dated.rows.some((row) => row.date === day)) {
        return { sent: 0, bounced: 0 };
      }
      return sumVolume(matched);
    }
    return sumVolume(dated.rows);
  }

  return volumeFromRow(root);
}

function datedVolumeRows(root: Record<string, unknown>): {
  present: boolean;
  rows: Array<{ date?: string; sent: number; bounced: number }>;
} {
  for (const key of ["data", "result", "analytics", "days", "stats"]) {
    const value = root[key];
    if (!Array.isArray(value)) continue;
    return {
      present: true,
      rows: value
        .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
        .map((row) => ({ date: rowDate(row), ...volumeFromRow(row) })),
    };
  }
  return { present: false, rows: [] };
}

function rowDate(row: Record<string, unknown>): string | undefined {
  const raw = pickString(row, ["date", "day", "start_date", "stats_date", "sent_date"]);
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return undefined;
}

function volumeFromRow(row: Record<string, unknown>): { sent: number; bounced: number } {
  return {
    sent: pickNumber(row, ["sent_count", "sent", "emails_sent", "total_sent"]) ?? 0,
    bounced: pickNumber(row, ["bounce_count", "bounces", "total_bounced", "bounced"]) ?? 0,
  };
}

function sumVolume(
  rows: Array<{ sent: number; bounced: number }>,
): { sent: number; bounced: number } {
  return rows.reduce(
    (sum, row) => ({
      sent: sum.sent + Math.max(0, row.sent),
      bounced: sum.bounced + Math.max(0, row.bounced),
    }),
    { sent: 0, bounced: 0 },
  );
}

export function pulseSlot(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, "0")}`;
}

/** How late a queued :05 pulse may still post that slot (next slot is 2h later). */
export const PULSE_GRACE_MINUTES = 110;

export function isPulseWindow(
  now: Date,
  timeZone: string,
  hours: number[],
  weekdays: number[] = [1, 2, 3, 4],
): boolean {
  if (!weekdays.includes(weekdayInZone(now, timeZone))) return false;
  return hours.includes(hourInZone(now, timeZone));
}

/**
 * Pulse slot for `now`, including a grace window so a watch-blocked 10:05
 * run still posts when it drains at 10:40 (or even 11:50). Does not snap
 * to 5pm — that hour is digest-only.
 */
export function resolvePulseSlot(
  now: Date,
  timeZone: string,
  hours: number[],
  weekdays: number[] = [1, 2, 3, 4],
  graceMinutes = PULSE_GRACE_MINUTES,
): { day: string; hour: number; slot: string } | null {
  if (!weekdays.includes(weekdayInZone(now, timeZone))) return null;
  const day = ymdInZone(now, timeZone);
  const hour = hourInZone(now, timeZone);
  if (hours.includes(hour)) {
    return { day, hour, slot: pulseSlot(day, hour) };
  }
  const minutes = minutesInZone(now, timeZone);
  const prior = [...hours].sort((a, b) => b - a).find((candidate) => {
    const elapsed = minutes - candidate * 60;
    return elapsed >= 0 && elapsed <= graceMinutes;
  });
  if (prior == null) return null;
  return { day, hour: prior, slot: pulseSlot(day, prior) };
}

export function formatClientPulse(input: {
  day: string;
  hour: number;
  clients: ClientPulse[];
  bounceWarn: number;
  paused?: PausedPulseRow[];
}): string {
  const totalSent = input.clients.reduce((sum, row) => sum + row.sent, 0);
  const totalBounced = input.clients.reduce((sum, row) => sum + row.bounced, 0);
  const lines = [`*${formatStamp(input.day, input.hour)} — sent today*`];
  for (const row of input.clients) {
    lines.push(`*${row.clientName}* — ${formatClientLine(row, input.bounceWarn)}`);
  }
  const overall = bouncePercent(totalSent, totalBounced);
  lines.push(
    `Total ${totalSent.toLocaleString()} sent` +
      (overall != null ? ` · ${formatPct(overall)} bounce` : ""),
  );
  const paused = [...(input.paused ?? [])]
    .filter((row) => !isNoiseCampaign(row.campaignName))
    .sort(
    (a, b) =>
      a.clientName.localeCompare(b.clientName) ||
      a.campaignName.localeCompare(b.campaignName),
  );
  if (paused.length) {
    lines.push("");
    lines.push(`*Paused* (${paused.length})`);
    for (const row of paused) {
      const campaign = shortCampaignName(row.clientName, row.campaignName);
      lines.push(`• *${row.clientName}* — ${campaign}`);
    }
  }
  return lines.join("\n");
}

function formatClientLine(row: ClientPulse, bounceWarn: number): string {
  if (row.sent <= 0) return "0 sent";
  const pct = bouncePercent(row.sent, row.bounced);
  if (pct == null) return `${row.sent.toLocaleString()} sent`;
  const label = `${formatPct(pct)} bounce`;
  return `${row.sent.toLocaleString()} sent · ${pct + 1e-9 >= bounceWarn ? `*${label}*` : label}`;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatStamp(ymd: string, hour: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour >= 12 ? "pm" : "am";
  return `${weekday} ${month}/${day} ${hour12}:00${suffix}`;
}
