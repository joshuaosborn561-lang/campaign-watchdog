import { clientGroupKey } from "./clients.js";
import { isNoiseCampaign } from "./names.js";
import { isPulseExcludedCampaign, type PulseExclude } from "./pulse.js";
import { type CampaignSchedule } from "./schedule.js";
import {
  clockMinutesInZone,
  hourInZone,
  minutesInZone,
  weekdayInZone,
  ymdInZone,
} from "./time.js";

/** 40 exclusive senders × ~30 messages/day. */
export const VOLUME_TARGET_SENDS = 1200;

/** More than 10% under the 1,200-send day. */
export const VOLUME_ALERT_MAX = 1080;

/** Noon America/Chicago slot the projection is anchored to. */
export const VOLUME_SLOT_HOUR = 12;

export const DEFAULT_VOLUME_WEEKDAYS = [1, 2, 3, 4, 5];

/** How late a watch-blocked noon check may still post that day's slot. */
export const VOLUME_GRACE_MINUTES = 80;

/** End-of-day window starts at 5pm CT; 6pm still counts, no later catch-up. */
export const EOD_HOUR = 17;
export const EOD_GRACE_MINUTES = 90;

/** Client needs a lead top-up when remaining / 1,200-send days is under this. */
export const EMAIL_RUNWAY_DAYS = 7;

export interface VolumeCampaignInput {
  clientId?: number | null;
  clientName: string;
  sent: number;
  remaining?: number | null;
  schedule: CampaignSchedule;
}

export interface ClientVolumeRow {
  clientId: number | null;
  clientName: string;
  sent: number;
  projected: number;
  remaining: number | null;
  daysLeft: number | null;
  under: boolean;
  needsTopUp: boolean;
  fraction: number;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Elapsed share of a send window at `nowMinutes` (minutes past midnight).
 * `null` means the window has not started — do not project.
 */
export function windowElapsedFraction(
  startMinutes: number,
  endMinutes: number,
  nowMinutes: number,
): number | null {
  const span = endMinutes - startMinutes;
  if (span <= 0) return null;
  if (nowMinutes <= startMinutes) return null;
  if (nowMinutes >= endMinutes) return 1;
  return (nowMinutes - startMinutes) / span;
}

export function projectDayTotal(sent: number, fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return Math.max(0, sent);
  return Math.max(0, sent) / fraction;
}

export function volumeAlertMax(target = VOLUME_TARGET_SENDS): number {
  return Math.floor(target * 0.9);
}

export function emailDaysLeft(
  remaining: number | null | undefined,
  dailyTarget = VOLUME_TARGET_SENDS,
): number | null {
  if (remaining == null || !Number.isFinite(remaining) || dailyTarget <= 0) return null;
  return Math.max(0, remaining) / dailyTarget;
}

export function needsEmailTopUp(
  daysLeft: number | null,
  minDays = EMAIL_RUNWAY_DAYS,
): boolean {
  return daysLeft != null && daysLeft < minDays;
}

function sumRemaining(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Math.max(0, value), 0);
}

export function isVolumeSkippedCampaign(
  campaign: { id?: number | null; name?: string },
  exclude?: PulseExclude,
): boolean {
  return (
    isNoiseCampaign(String(campaign.name ?? "")) ||
    isPulseExcludedCampaign(campaign, exclude)
  );
}

export function scheduleWindowMinutesInZone(
  schedule: CampaignSchedule,
  now: Date,
  targetTimeZone: string,
): { start: number; end: number } {
  return {
    start: clockMinutesInZone(
      schedule.startHour * 60 + schedule.startMinute,
      schedule.timeZone,
      targetTimeZone,
      now,
    ),
    end: clockMinutesInZone(
      schedule.endHour * 60 + schedule.endMinute,
      schedule.timeZone,
      targetTimeZone,
      now,
    ),
  };
}

export function unionClientWindow(
  schedules: CampaignSchedule[],
  now: Date,
  targetTimeZone: string,
): { start: number; end: number } | null {
  if (!schedules.length) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const schedule of schedules) {
    const window = scheduleWindowMinutesInZone(schedule, now, targetTimeZone);
    start = Math.min(start, window.start);
    end = Math.max(end, window.end);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

export function rollupClientVolume(
  rows: VolumeCampaignInput[],
  now: Date,
  targetTimeZone: string,
  slotHour = VOLUME_SLOT_HOUR,
): ClientVolumeRow[] {
  const groups = new Map<
    string,
    {
      clientId: number | null;
      clientName: string;
      sent: number;
      remainings: Array<number | null | undefined>;
      schedules: CampaignSchedule[];
    }
  >();
  for (const row of rows) {
    const key = clientGroupKey(row);
    const current = groups.get(key) ?? {
      clientId: row.clientId ?? null,
      clientName: row.clientName,
      sent: 0,
      remainings: [],
      schedules: [],
    };
    current.sent += Math.max(0, row.sent);
    current.remainings.push(row.remaining);
    current.schedules.push(row.schedule);
    groups.set(key, current);
  }

  const slotMinutes = slotHour * 60;
  const out: ClientVolumeRow[] = [];
  for (const group of groups.values()) {
    const window = unionClientWindow(group.schedules, now, targetTimeZone);
    if (!window) continue;
    const fraction = windowElapsedFraction(window.start, window.end, slotMinutes);
    if (fraction == null) continue;
    const projected = projectDayTotal(group.sent, fraction);
    const remaining = sumRemaining(group.remainings);
    const daysLeft = emailDaysLeft(remaining);
    out.push({
      clientId: group.clientId,
      clientName: group.clientName,
      sent: group.sent,
      projected,
      remaining,
      daysLeft,
      under: projected < VOLUME_ALERT_MAX,
      needsTopUp: needsEmailTopUp(daysLeft),
      fraction,
      startMinutes: window.start,
      endMinutes: window.end,
    });
  }
  return out;
}

export function rollupClientEod(
  rows: VolumeCampaignInput[],
  target = VOLUME_TARGET_SENDS,
  alertMax = VOLUME_ALERT_MAX,
): ClientVolumeRow[] {
  const groups = new Map<
    string,
    {
      clientId: number | null;
      clientName: string;
      sent: number;
      remainings: Array<number | null | undefined>;
    }
  >();
  for (const row of rows) {
    const key = clientGroupKey(row);
    const current = groups.get(key) ?? {
      clientId: row.clientId ?? null,
      clientName: row.clientName,
      sent: 0,
      remainings: [],
    };
    current.sent += Math.max(0, row.sent);
    current.remainings.push(row.remaining);
    groups.set(key, current);
  }

  const out: ClientVolumeRow[] = [];
  for (const group of groups.values()) {
    const remaining = sumRemaining(group.remainings);
    const daysLeft = emailDaysLeft(remaining, target);
    out.push({
      clientId: group.clientId,
      clientName: group.clientName,
      sent: group.sent,
      projected: group.sent,
      remaining,
      daysLeft,
      under: group.sent < alertMax,
      needsTopUp: needsEmailTopUp(daysLeft),
      fraction: 1,
      startMinutes: 0,
      endMinutes: 0,
    });
  }
  return out;
}

export function flagUnderVolume(
  rows: ClientVolumeRow[],
  alertMax = VOLUME_ALERT_MAX,
): ClientVolumeRow[] {
  return sortVolumeRows(rows.filter((row) => row.projected < alertMax || row.under));
}

export function sortVolumeRows(rows: ClientVolumeRow[]): ClientVolumeRow[] {
  return [...rows].sort((a, b) => {
    const rank = (row: ClientVolumeRow) => Number(row.under || row.needsTopUp);
    return (
      rank(b) - rank(a) ||
      a.projected - b.projected ||
      a.sent - b.sent ||
      a.clientName.localeCompare(b.clientName) ||
      (a.clientId ?? 0) - (b.clientId ?? 0)
    );
  });
}

export function volumeSlot(day: string): string {
  return `${day}T${String(VOLUME_SLOT_HOUR).padStart(2, "0")}`;
}

export function resolveVolumeSlot(
  now: Date,
  timeZone: string,
  weekdays: number[] = DEFAULT_VOLUME_WEEKDAYS,
  slotHour = VOLUME_SLOT_HOUR,
  graceMinutes = VOLUME_GRACE_MINUTES,
): { day: string; hour: number; slot: string } | null {
  if (!weekdays.includes(weekdayInZone(now, timeZone))) return null;
  const day = ymdInZone(now, timeZone);
  const hour = hourInZone(now, timeZone);
  if (hour === slotHour) {
    return { day, hour: slotHour, slot: volumeSlot(day) };
  }
  const elapsed = minutesInZone(now, timeZone) - slotHour * 60;
  if (elapsed >= 0 && elapsed <= graceMinutes) {
    return { day, hour: slotHour, slot: volumeSlot(day) };
  }
  return null;
}

export function resolveEodSlot(
  now: Date,
  timeZone: string,
  weekdays: number[] = DEFAULT_VOLUME_WEEKDAYS,
  startHour = EOD_HOUR,
  graceMinutes = EOD_GRACE_MINUTES,
): { day: string; hour: number; slot: string } | null {
  if (!weekdays.includes(weekdayInZone(now, timeZone))) return null;
  const day = ymdInZone(now, timeZone);
  const elapsed = minutesInZone(now, timeZone) - startHour * 60;
  if (elapsed < 0 || elapsed > graceMinutes) return null;
  return { day, hour: startHour, slot: `${day}T${String(startHour).padStart(2, "0")}` };
}

/** Compact midday post: one line per active client. Empty if nobody is sending. */
export function formatMiddayReport(
  rows: ClientVolumeRow[],
  day: string,
): string | null {
  if (!rows.length) return null;
  const lines = [`*Midday — ${formatDayStamp(day, 12)}*`];
  for (const row of sortVolumeRows(rows)) {
    const proj = Math.round(row.projected).toLocaleString();
    const flag = row.under ? " · *under*" : " · on track";
    lines.push(
      `• ${formatClientLabel(row)} — ${row.sent.toLocaleString()} sent → ${proj} proj${flag}`,
    );
  }
  return lines.join("\n");
}

/** Compact EOD post: sends vs 1,200, plus <7d top-up. Empty if no active clients. */
export function formatEodReport(
  rows: ClientVolumeRow[],
  day: string,
  target = VOLUME_TARGET_SENDS,
): string | null {
  if (!rows.length) return null;
  const lines = [`*EOD — ${formatDayStamp(day)}*`];
  for (const row of sortVolumeRows(rows)) {
    const bits = [`${row.sent.toLocaleString()} / ${target.toLocaleString()}`];
    if (row.under) bits.push("*under*");
    if (row.needsTopUp && row.daysLeft != null) {
      bits.push(`*${formatDaysLeft(row.daysLeft)} left, needs top-up*`);
    }
    lines.push(`• ${formatClientLabel(row)} — ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

/** @deprecated use formatMiddayReport — kept for the flagged-only helper tests. */
export function formatVolumeAlert(
  rows: ClientVolumeRow[],
  day: string,
  _target = VOLUME_TARGET_SENDS,
  _alertMax = VOLUME_ALERT_MAX,
): string | null {
  return formatMiddayReport(rows, day);
}

function formatClientLabel(row: Pick<ClientVolumeRow, "clientId" | "clientName">): string {
  const id = row.clientId != null ? ` \`#${row.clientId}\`` : "";
  return `*${row.clientName}*${id}`;
}

function formatDaysLeft(days: number): string {
  if (days <= 0) return "0d";
  if (days < 10) return `~${days.toFixed(1)}d`;
  return `~${Math.round(days)}d`;
}

function formatDayStamp(ymd: string, hour?: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  if (hour == null) return `${weekday} ${month}/${day}`;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour >= 12 ? "pm" : "am";
  return `${weekday} ${month}/${day} ${hour12}:00${suffix}`;
}
