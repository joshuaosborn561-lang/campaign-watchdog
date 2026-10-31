export interface BookingRow {
  clientSlug: string;
  createdAt: string;
}

export interface DroughtClient {
  clientId: number;
  name: string;
  slug: string;
}

export interface DroughtClientStatus {
  client: DroughtClient;
  meetingsInWindow: number;
  lastBookingAt: string | null;
  daysSinceLast: number | null;
}

/** campaignintelligence booking-page log slugs by Smartlead client id (Campaign Watchdog source.md). */
export const DEFAULT_DROUGHT_CLIENT_SLUGS: Record<number, string> = {
  345263: "salesglider",
  418274: "parlay",
  521881: "techevo",
  542838: "bolder",
  566991: "nutter",
  574020: "emcor",
  592842: "powergryd",
  597119: "vector",
};
/** Active clients with no booking source: Roofs by Peterson (books direct), Insight (no booking page). */
export const DEFAULT_DROUGHT_UNCOVERED_CLIENT_IDS = [548610, 582890];
export const IGNORED_BOOKING_SLUGS = new Set(["zz-test", "example"]);

export function parseSlugMap(raw: string | undefined): Record<number, string> {
  if (!raw?.trim()) return DEFAULT_DROUGHT_CLIENT_SLUGS;
  const out: Record<number, string> = {};
  for (const part of raw.split(",")) {
    const [id, slug] = part.split(":").map((value) => value.trim());
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && slug) out[n] = slug.toLowerCase();
  }
  return Object.keys(out).length ? out : DEFAULT_DROUGHT_CLIENT_SLUGS;
}

export function isTestBooking(row: { clientSlug: string; leadEmail?: string | null }): boolean {
  if (IGNORED_BOOKING_SLUGS.has(row.clientSlug.toLowerCase())) return true;
  const email = (row.leadEmail ?? "").toLowerCase();
  return /@example\.(com|org)$/.test(email) || /(^|[-_.])test[-_.@]/.test(email);
}

/** Meetings booked in the trailing `windowDays` (rolling, by booking time) and the last booking ever. */
export function computeDrought(
  clients: DroughtClient[],
  bookings: BookingRow[],
  now: Date,
  windowDays: number,
): DroughtClientStatus[] {
  const cutoff = now.getTime() - windowDays * 86_400_000;
  return clients.map((client) => {
    let count = 0;
    let last: number | null = null;
    for (const booking of bookings) {
      if (booking.clientSlug.toLowerCase() !== client.slug) continue;
      const at = Date.parse(booking.createdAt);
      if (!Number.isFinite(at) || at > now.getTime()) continue;
      if (at >= cutoff) count += 1;
      if (last == null || at > last) last = at;
    }
    return {
      client,
      meetingsInWindow: count,
      lastBookingAt: last == null ? null : new Date(last).toISOString(),
      daysSinceLast: last == null ? null : Math.floor((now.getTime() - last) / 86_400_000),
    };
  });
}

export interface DroughtAlertEntry {
  lastAlertedAt: string;
}

/**
 * Exceptions only: a client under `minMeetings` in the window alerts when it first crosses,
 * then again every `repeatDays` while it stays dry. Clients back above the line reset.
 */
export function decideDroughtAlerts(
  statuses: DroughtClientStatus[],
  prior: Record<string, DroughtAlertEntry>,
  now: Date,
  opts: { minMeetings: number; repeatDays: number },
): { toAlert: DroughtClientStatus[]; next: Record<string, DroughtAlertEntry> } {
  const next: Record<string, DroughtAlertEntry> = {};
  const toAlert: DroughtClientStatus[] = [];
  for (const status of statuses) {
    if (status.meetingsInWindow >= opts.minMeetings) continue;
    const key = String(status.client.clientId);
    const before = prior[key];
    const age = before ? now.getTime() - Date.parse(before.lastAlertedAt) : Infinity;
    if (!before || !(age < opts.repeatDays * 86_400_000 - 3_600_000)) {
      toAlert.push(status);
      next[key] = { lastAlertedAt: now.toISOString() };
    } else {
      next[key] = before;
    }
  }
  return { toAlert, next };
}

function fmtDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

export function formatDroughtAlert(input: {
  header: string;
  statuses: DroughtClientStatus[];
  windowDays: number;
  timeZone: string;
  uncoveredNames?: string[];
}): string | null {
  if (!input.statuses.length && !input.uncoveredNames?.length) return null;
  const lines = [`*${input.header}*`];
  for (const status of [...input.statuses].sort(
    (a, b) => (b.daysSinceLast ?? 9999) - (a.daysSinceLast ?? 9999),
  )) {
    const last =
      status.lastBookingAt == null
        ? "no bookings on record"
        : `last booked ${fmtDate(status.lastBookingAt, input.timeZone)}, ${status.daysSinceLast}d ago`;
    lines.push(
      `• *${status.client.name}* — ${status.meetingsInWindow} meetings in ${input.windowDays} days (${last}). Target 1–2 a week.`,
    );
  }
  if (input.uncoveredNames?.length) {
    lines.push(`_Can't check, no booking source: ${input.uncoveredNames.join(", ")}._`);
  }
  return lines.join("\n");
}
