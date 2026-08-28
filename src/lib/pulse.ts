import { bounceRateFrom } from "./autobounce.js";
import { isNoiseCampaign, shortCampaignName } from "./names.js";
import { hourInZone, weekdayInZone } from "./time.js";

export interface ClientPulse {
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
  rows: Array<{ clientName: string; sent: number; bounced: number }>,
): ClientPulse[] {
  const groups = new Map<string, ClientPulse>();
  for (const row of rows) {
    const current = groups.get(row.clientName) ?? {
      clientName: row.clientName,
      sent: 0,
      bounced: 0,
    };
    current.sent += Math.max(0, row.sent);
    current.bounced += Math.max(0, row.bounced);
    groups.set(row.clientName, current);
  }
  return [...groups.values()].sort(
    (a, b) => b.sent - a.sent || a.clientName.localeCompare(b.clientName),
  );
}

export function bouncePercent(sent: number, bounced: number): number | null {
  if (sent <= 0) return null;
  return (bounced / sent) * 100;
}

export function parseTodayVolume(raw: unknown): { sent: number; bounced: number } {
  const stats = bounceRateFrom(raw);
  return {
    sent: stats.sent ?? 0,
    bounced: stats.bounceCount ?? 0,
  };
}

export function pulseSlot(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, "0")}`;
}

export function isPulseWindow(
  now: Date,
  timeZone: string,
  hours: number[],
  weekdays: number[] = [1, 2, 3, 4],
): boolean {
  if (!weekdays.includes(weekdayInZone(now, timeZone))) return false;
  const hour = hourInZone(now, timeZone);
  if (!hours.length) return false;
  return hour >= Math.min(...hours) && hour <= Math.max(...hours);
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
  const paused = [...(input.paused ?? [])].sort(
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
