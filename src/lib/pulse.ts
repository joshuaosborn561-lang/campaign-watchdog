import { clientGroupKey } from "./clients.js";
import { isNoiseCampaign, shortCampaignName } from "./names.js";
import { pickNumber, pickString, unwrap } from "./parse.js";
import { hourInZone, minutesInZone, weekdayInZone, ymdInZone } from "./time.js";

export type PulseShortfall = "too few senders" | "too few leads" | "smtp_down" | "not_sending";

export interface ClientPulse {
  clientId?: number | null;
  clientName: string;
  sent: number;
  bounced: number;
}

export interface OffTrackPulseRow {
  clientName: string;
  campaignName: string;
  campaignId?: number;
  reason: string;
  kind?: PulseShortfall;
}

/** First pulse slot where a 0-send ACTIVE camp is worth diagnosing (window is usually 9am). */
export const PULSE_SHORTFALL_AFTER_HOUR = 10;

/** Deliverability CANON floor — exclusive senders on an ACTIVE list. */
export const CANON_MIN_SENDERS = 40;

export const DEFAULT_PULSE_WEEKDAYS = [1, 2, 3, 4, 5];

const LOW_LEAD_REMAINING = 10;
const OFF_TRACK_SENT_MAX = 2;

export interface PausedPulseRow {
  clientName: string;
  campaignName: string;
  campaignId?: number;
}

export interface PulseExclude {
  ids?: Iterable<number>;
  names?: Iterable<string>;
}

/** Known Smartlead IDs for legacy Nieto / MSRS / Positive leftovers. */
export const DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS = [
  3437329, // Nieto Sports or Airpods Offer/Proprietary Tech
  3628940, // MSRS2 Ticket Offer Property Manager
  3628943, // Positive
  3867914, // Nieto RB2B
  3867917, // Nieto Houston Floodzones
];

/**
 * Intentional Unknown-client leftovers (Nieto / MSRS / Positive).
 * Keep the "Propert" typo on the first MSRS name — that is the live campaign title.
 */
export const DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES = [
  "MSRS Ticket Offer Propert Manager",
  "MSRS2 Ticket Offer Property Manager",
  "Nieto Astros Offer/Proprietary Tech",
  "Nieto Houston Floodzones",
  "Nieto Law Firms",
  "Nieto MSPs 20-200",
  "Nieto RB2B",
  "Nieto Sports or Airpods Offer/Proprietary Tech",
  "Nieto Spring",
  "Positive",
];

export function isPulseExcludedCampaign(
  campaign: { id?: number | null; name?: string },
  exclude?: PulseExclude,
): boolean {
  const ids = new Set(exclude?.ids ?? DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS);
  const names = new Set(
    [...(exclude?.names ?? DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES)]
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  if (campaign.id != null && ids.has(Number(campaign.id))) return true;
  const name = String(campaign.name ?? "").trim().toLowerCase();
  return name.length > 0 && names.has(name);
}

/** Every still-paused real campaign, including ones left paused on purpose (e.g. Generic). */
export function stillPausedCampaigns<T extends { id?: number; name: string; status: string }>(
  campaigns: T[],
  exclude?: PulseExclude,
): T[] {
  return campaigns.filter(
    (campaign) =>
      String(campaign.status ?? "").toUpperCase() === "PAUSED" &&
      !isNoiseCampaign(campaign.name) &&
      !isPulseExcludedCampaign(campaign, exclude),
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
  weekdays: number[] = DEFAULT_PULSE_WEEKDAYS,
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
  weekdays: number[] = DEFAULT_PULSE_WEEKDAYS,
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

export function visiblePausedRows(
  paused: PausedPulseRow[],
  exclude?: PulseExclude,
): PausedPulseRow[] {
  return paused.filter(
    (row) =>
      !isNoiseCampaign(row.campaignName) &&
      !isPulseExcludedCampaign(
        { id: row.campaignId, name: row.campaignName },
        exclude,
      ),
  );
}

/** Pauses whose last-seen timestamp falls on this calendar day in `timeZone`. */
export function pausedSeenOnDay(
  paused: PausedPulseRow[],
  seenAt: Map<number, string | undefined>,
  day: string,
  timeZone: string,
): PausedPulseRow[] {
  return paused.filter((row) => {
    if (row.campaignId == null) return false;
    const raw = seenAt.get(row.campaignId);
    if (!raw) return false;
    const at = new Date(raw);
    return !Number.isNaN(at.getTime()) && ymdInZone(at, timeZone) === day;
  });
}

export function classifyPulseShortfall(input: {
  remaining: number | null;
  staffable: number | null;
  notStarted?: number | null;
  attached?: number | null;
  disconnected?: number | null;
  sent?: number;
}): PulseShortfall | null {
  return classifyPulseOffTrack(input)?.kind ?? null;
}

/**
 * ACTIVE 0-send (or near-0) diagnosis for the pulse Off-track section.
 * Priority: thin hopper → SMTP/IMAP down → below CANON min-40 → dry new leads → stall.
 */
export function classifyPulseOffTrack(input: {
  sent?: number;
  remaining: number | null;
  notStarted?: number | null;
  staffable: number | null;
  attached?: number | null;
  disconnected?: number | null;
}): { kind: PulseShortfall; reason: string } | null {
  const sent = Math.max(0, input.sent ?? 0);
  if (sent > OFF_TRACK_SENT_MAX) return null;

  const remaining = input.remaining;
  const notStarted = input.notStarted ?? null;
  const staffable = input.staffable ?? 0;
  const attached = input.attached ?? staffable;
  const disconnected = input.disconnected ?? Math.max(0, attached - staffable);
  const thin = remaining != null && remaining < LOW_LEAD_REMAINING;
  const dryNew = notStarted != null && notStarted <= 0;
  const smtpDown =
    attached >= 5 &&
    disconnected > 0 &&
    staffable <= Math.max(1, Math.floor(attached * 0.3));
  const belowCanon = input.staffable != null && staffable < CANON_MIN_SENDERS;

  if (thin) {
    return {
      kind: "too few leads",
      reason: formatLeadsReason(notStarted, remaining),
    };
  }
  if (smtpDown) {
    return {
      kind: "smtp_down",
      reason: `${disconnected} of ${attached} attached SMTP/IMAP down`,
    };
  }
  if (belowCanon) {
    return {
      kind: "too few senders",
      reason: `too few senders (${staffable}/${attached} vs CANON min-40)`,
    };
  }
  if (dryNew) {
    return {
      kind: "too few leads",
      reason: formatLeadsReason(notStarted, remaining),
    };
  }
  if (remaining != null && remaining >= LOW_LEAD_REMAINING && staffable >= 3) {
    return {
      kind: "not_sending",
      reason: `not sending (${sent} sent, ${remaining.toLocaleString()} left)`,
    };
  }
  return null;
}

function formatLeadsReason(notStarted: number | null, remaining: number | null): string {
  const parts: string[] = [];
  if (notStarted != null) parts.push(`notStarted=${notStarted}`);
  if (remaining != null) parts.push(`remaining=${remaining.toLocaleString()}`);
  return parts.length ? `too few leads (${parts.join(", ")})` : "too few leads";
}

export function formatClientPulse(input: {
  day: string;
  hour: number;
  clients: ClientPulse[];
  bounceWarn: number;
  paused?: PausedPulseRow[];
  pausedToday?: PausedPulseRow[];
  offTrack?: OffTrackPulseRow[];
  exclude?: PulseExclude;
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
  const paused = visiblePausedRows(input.paused ?? [], input.exclude);
  if (paused.length) {
    lines.push(`Paused: ${paused.length} (new pauses still alert via 15m watch)`);
    const fresh = visiblePausedRows(input.pausedToday ?? [], input.exclude).sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.campaignName.localeCompare(b.campaignName),
    );
    for (const row of fresh) {
      lines.push(`• *${row.clientName}* — ${formatPulseCampaign(row)} (today)`);
    }
  }
  const offTrack = [...(input.offTrack ?? [])]
    .filter(
      (row) =>
        !isNoiseCampaign(row.campaignName) &&
        !isPulseExcludedCampaign(
          { id: row.campaignId, name: row.campaignName },
          input.exclude,
        ),
    )
    .sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.campaignName.localeCompare(b.campaignName),
    );
  if (offTrack.length) {
    lines.push("");
    lines.push("*Off track*");
    for (const row of offTrack) {
      lines.push(`• *${row.clientName}* — ${formatPulseCampaign(row)} — ${row.reason}`);
    }
  }
  return lines.join("\n");
}

function formatPulseCampaign(row: {
  clientName: string;
  campaignName: string;
  campaignId?: number;
}): string {
  const name = shortCampaignName(row.clientName, row.campaignName);
  return row.campaignId != null ? `${name} \`#${row.campaignId}\`` : name;
}

function formatClientLine(row: ClientPulse, bounceWarn: number): string {
  if (row.sent <= 0) {
    return "0 sent";
  }
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
