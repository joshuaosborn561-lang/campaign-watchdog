export function ymdInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return now.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

export function hourInZone(now: Date, timeZone: string): number {
  return Math.floor(minutesInZone(now, timeZone) / 60);
}

export function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + (Number.isFinite(minute) ? minute : 0);
}

export function weekdayInZone(now: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? now.getUTCDay();
}

export function isWeekendInZone(now: Date, timeZone: string): boolean {
  const day = weekdayInZone(now, timeZone);
  return day === 0 || day === 6;
}

/** Minutes to add to UTC to get wall clock in `timeZone` at `now` (DST-aware). */
export function utcOffsetMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const second = Number(parts.find((part) => part.type === "second")?.value ?? "0");
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - now.getTime()) / 60_000);
}

/**
 * Convert a clock time in `sourceTimeZone` (minutes past midnight) to minutes
 * past midnight in `targetTimeZone` on the same instant as `now`.
 */
export function clockMinutesInZone(
  clockMinutes: number,
  sourceTimeZone: string,
  targetTimeZone: string,
  now: Date,
): number {
  const sourceOffset = utcOffsetMinutes(now, sourceTimeZone);
  const targetOffset = utcOffsetMinutes(now, targetTimeZone);
  return clockMinutes - sourceOffset + targetOffset;
}
