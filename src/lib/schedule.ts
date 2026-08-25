import { asNumber, pickNumber, pickString, unwrap } from "./parse.js";
import { weekdayInZone } from "./time.js";

export interface CampaignSchedule {
  timeZone: string;
  days: number[];
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  gapMinutes: number;
  maxLeadsPerDay: number | null;
}

export function parseClock(value: unknown): { hour: number; minute: number } | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { hour: Math.floor(value), minute: 0 };
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = value
    .map((item) => asNumber(item))
    .filter((item): item is number => item != null)
    .map((item) => (item === 7 ? 0 : item));
  return days.length ? days : null;
}

export function parseCampaignSchedule(
  raw: unknown,
  defaults: { timeZone: string; gapMinutes: number },
): CampaignSchedule {
  const root = unwrap(raw) ?? {};
  const cron = unwrap(root.scheduler_cron_value ?? root.schedulerCronValue ?? root.schedule);
  const from = { ...root, ...(cron ?? {}) };

  const start =
    parseClock(from.startHour ?? from.start_hour ?? from.start_time) ?? {
      hour: 9,
      minute: 0,
    };
  const end =
    parseClock(from.endHour ?? from.end_hour ?? from.end_time) ?? {
      hour: 17,
      minute: 0,
    };
  const days =
    parseDays(from.days ?? from.days_of_the_week ?? from.daysOfTheWeek) ?? [1, 2, 3, 4, 5];
  const gap =
    pickNumber(from, [
      "min_time_btwn_emails",
      "min_time_btw_emails",
      "minTimeToWaitInMins",
      "min_time_between_emails",
    ]) ?? defaults.gapMinutes;
  const maxLeads =
    pickNumber(from, [
      "max_new_leads_per_day",
      "max_leads_per_day",
      "maxLeadsPerDay",
      "sending_limit",
      "sendingLimit",
    ]) ?? null;

  return {
    timeZone:
      pickString(from, ["tz", "timezone", "time_zone", "timeZone"]) ?? defaults.timeZone,
    days,
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
    gapMinutes: gap > 0 ? gap : defaults.gapMinutes,
    maxLeadsPerDay: maxLeads != null && maxLeads > 0 ? maxLeads : null,
  };
}

export function windowMinutes(schedule: CampaignSchedule): number {
  const start = schedule.startHour * 60 + schedule.startMinute;
  const end = schedule.endHour * 60 + schedule.endMinute;
  const span = end - start;
  return span > 0 ? span : 0;
}

/** Sends one inbox can physically do in the window at the configured gap, capped by message-per-day. */
export function gapLimitedSendsPerInbox(
  schedule: CampaignSchedule,
  messagePerDay: number,
): number {
  const minutes = windowMinutes(schedule);
  if (minutes <= 0 || schedule.gapMinutes <= 0) return 0;
  const slots = Math.max(1, Math.floor(minutes / schedule.gapMinutes));
  return Math.min(messagePerDay, slots);
}

export function isSendDay(schedule: CampaignSchedule, now: Date): boolean {
  return schedule.days.includes(weekdayInZone(now, schedule.timeZone));
}

export function minutesPastMidnight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function windowHasEnded(schedule: CampaignSchedule, now: Date): boolean {
  const nowMins = minutesPastMidnight(now, schedule.timeZone);
  const end = schedule.endHour * 60 + schedule.endMinute;
  return nowMins >= end;
}
