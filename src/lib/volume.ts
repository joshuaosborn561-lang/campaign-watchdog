import { clientGroupKey } from "./clients.js";
import { isNoiseCampaign } from "./names.js";
import { isPulseExcludedCampaign, type PulseExclude } from "./pulse.js";
import { type CampaignSchedule } from "./schedule.js";
import { explainUnderVolume, formatUnderFlag } from "./under-reason.js";
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
  bounced?: number;
  attached?: number | null;
  staffable?: number | null;
  disconnected?: number | null;
  pausedCampaigns?: number;
  bounceHold?: boolean;
}

export interface ClientVolumeRow {
  clientId: number | null;
  clientName: string;
  sent: number;
  projected: number;
  remaining: number | null;
  daysLeft: number | null;
  under: boolean;
  /** One-sentence primary cause when `under` — never a campaign dump. */
  underReason?: string;
  needsTopUp: boolean;
  /** ACTIVE lists whose remaining / 1,200-send days is under EMAIL_RUNWAY_DAYS. */
  lowLeadCampaigns: number;
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

export function isLowLeadCampaign(
  remaining: number | null | undefined,
  dailyTarget = VOLUME_TARGET_SENDS,
  minDays = EMAIL_RUNWAY_DAYS,
): boolean {
  return needsEmailTopUp(emailDaysLeft(remaining, dailyTarget), minDays);
}

export function countLowLeadCampaigns(
  remainings: Array<number | null | undefined>,
  dailyTarget = VOLUME_TARGET_SENDS,
  minDays = EMAIL_RUNWAY_DAYS,
): number {
  return remainings.filter((remaining) => isLowLeadCampaign(remaining, dailyTarget, minDays))
    .length;
}

/** `• *BCP* — 3 low on leads` — clients with zero are omitted. */
export function formatLowOnLeadsLines(
  rows: Array<{ clientName: string; lowLeadCampaigns?: number }>,
): string[] {
  return [...rows]
    .filter((row) => (row.lowLeadCampaigns ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.lowLeadCampaigns ?? 0) - (a.lowLeadCampaigns ?? 0) ||
        a.clientName.localeCompare(b.clientName),
    )
    .map((row) => `• *${row.clientName}* — ${row.lowLeadCampaigns} low on leads`);
}

interface VolumeGroup {
  clientId: number | null;
  clientName: string;
  sent: number;
  bounced: number;
  remainings: Array<number | null | undefined>;
  schedules: CampaignSchedule[];
  attacheds: Array<number | null | undefined>;
  staffables: Array<number | null | undefined>;
  disconnecteds: Array<number | null | undefined>;
  pausedCampaigns: number;
  bounceHold: boolean;
  caps: Array<number | null>;
}

function addVolumeGroupRow(
  groups: Map<string, VolumeGroup>,
  row: VolumeCampaignInput,
): void {
  const key = clientGroupKey(row);
  const current = groups.get(key) ?? {
    clientId: row.clientId ?? null,
    clientName: row.clientName,
    sent: 0,
    bounced: 0,
    remainings: [],
    schedules: [],
    attacheds: [],
    staffables: [],
    disconnecteds: [],
    pausedCampaigns: 0,
    bounceHold: false,
    caps: [],
  };
  current.sent += Math.max(0, row.sent);
  current.bounced += Math.max(0, row.bounced ?? 0);
  current.remainings.push(row.remaining);
  current.schedules.push(row.schedule);
  current.attacheds.push(row.attached);
  current.staffables.push(row.staffable);
  current.disconnecteds.push(row.disconnected);
  current.pausedCampaigns = Math.max(current.pausedCampaigns, row.pausedCampaigns ?? 0);
  current.bounceHold = current.bounceHold || Boolean(row.bounceHold);
  current.caps.push(row.schedule.maxLeadsPerDay);
  groups.set(key, current);
}

function underSignalsFromGroup(
  group: VolumeGroup,
  remaining: number | null,
  outsideWindow: boolean,
  alertMax = VOLUME_ALERT_MAX,
) {
  return {
    sent: group.sent,
    remaining,
    bounced: group.bounced,
    attached: sumKnown(group.attacheds),
    staffable: sumKnown(group.staffables),
    disconnected: sumKnown(group.disconnecteds),
    pausedCampaigns: group.pausedCampaigns,
    activeCampaigns: group.schedules.length,
    bounceHold: group.bounceHold,
    maxLeadsPerDay: rollupDailyCap(group.caps),
    outsideWindow,
    alertMax,
  };
}

function rollupDailyCap(caps: Array<number | null>): number | null {
  const known = caps.filter((value): value is number => value != null && value > 0);
  if (!known.length) return null;
  if (known.length === caps.length) return known.reduce((sum, value) => sum + value, 0);
  return caps.length === 1 ? known[0] : null;
}

function sumKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + Math.max(0, value), 0);
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
  const groups = new Map<string, VolumeGroup>();
  for (const row of rows) {
    addVolumeGroupRow(groups, row);
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
    const lowLeadCampaigns = countLowLeadCampaigns(group.remainings);
    const under = projected < VOLUME_ALERT_MAX;
    const outsideWindow = slotMinutes < window.start || slotMinutes >= window.end;
    out.push({
      clientId: group.clientId,
      clientName: group.clientName,
      sent: group.sent,
      projected,
      remaining,
      daysLeft,
      under,
      underReason: under
        ? explainUnderVolume(underSignalsFromGroup(group, remaining, outsideWindow)).text
        : undefined,
      needsTopUp: lowLeadCampaigns > 0,
      lowLeadCampaigns,
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
  const groups = new Map<string, VolumeGroup>();
  for (const row of rows) {
    addVolumeGroupRow(groups, row);
  }

  const out: ClientVolumeRow[] = [];
  for (const group of groups.values()) {
    const remaining = sumRemaining(group.remainings);
    const daysLeft = emailDaysLeft(remaining, target);
    const lowLeadCampaigns = countLowLeadCampaigns(group.remainings, target);
    const under = group.sent < alertMax;
    out.push({
      clientId: group.clientId,
      clientName: group.clientName,
      sent: group.sent,
      projected: group.sent,
      remaining,
      daysLeft,
      under,
      underReason: under
        ? explainUnderVolume(underSignalsFromGroup(group, remaining, false, alertMax)).text
        : undefined,
      needsTopUp: lowLeadCampaigns > 0,
      lowLeadCampaigns,
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
    const flag = row.under ? formatUnderFlag(true, row.underReason) : " · on track";
    lines.push(
      `• ${formatClientLabel(row)} — ${row.sent.toLocaleString()} sent → ${proj} proj${flag}`,
    );
  }
  return lines.join("\n");
}

/** Compact EOD post: sends vs 1,200, plus per-client low-on-leads counts. */
export function formatEodReport(
  rows: ClientVolumeRow[],
  day: string,
  target = VOLUME_TARGET_SENDS,
): string | null {
  if (!rows.length) return null;
  const lines = [`*EOD — ${formatDayStamp(day)}*`];
  for (const row of sortVolumeRows(rows)) {
    const bits = [`${row.sent.toLocaleString()} / ${target.toLocaleString()}`];
    if (row.under) {
      lines.push(
        `• ${formatClientLabel(row)} — ${bits.join(" · ")}${formatUnderFlag(true, row.underReason)}`,
      );
    } else {
      lines.push(`• ${formatClientLabel(row)} — ${bits.join(" · ")}`);
    }
  }
  const lowLines = formatLowOnLeadsLines(rows);
  if (lowLines.length) {
    lines.push("");
    lines.push(...lowLines);
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

function formatDayStamp(ymd: string, hour?: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  if (hour == null) return `${weekday} ${month}/${day}`;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour >= 12 ? "pm" : "am";
  return `${weekday} ${month}/${day} ${hour12}:00${suffix}`;
}
