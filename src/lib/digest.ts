import { shortCampaignName } from "./names.js";
import type { SendingKind } from "./sending.js";
import { bouncePercent } from "./pulse.js";

export { shortCampaignName };

export interface DigestCampaign {
  clientName: string;
  campaignName: string;
  sent: number;
  bounced: number;
  remaining: number;
  notStarted: number;
  inProgress: number;
  staffable: number;
  attached: number;
  kind: SendingKind | "unknown";
  shouldAlert: boolean;
  status?: string;
}

export interface ClientDigest {
  clientName: string;
  severity: "problem" | "fine" | "quiet";
  line: string;
}

/** Today's sends: first-touch if the campaign still has unstarted leads, else follow-up. */
export function classifyTodaySends(row: {
  sent: number;
  notStarted: number;
  inProgress: number;
}): { firstTouch: number; followUp: number } {
  if (row.sent <= 0) return { firstTouch: 0, followUp: 0 };
  if (row.notStarted <= 0) return { firstTouch: 0, followUp: row.sent };
  if (row.inProgress <= row.sent) return { firstTouch: row.sent, followUp: 0 };
  if (row.notStarted >= row.inProgress) return { firstTouch: row.sent, followUp: 0 };
  return { firstTouch: 0, followUp: row.sent };
}

export function digestTotals(campaigns: DigestCampaign[]): {
  sent: number;
  bounced: number;
  firstTouch: number;
  followUp: number;
  waitingNew: number;
  waitingFollowUp: number;
  finishedToday: DigestCampaign[];
  paused: DigestCampaign[];
} {
  let sent = 0;
  let bounced = 0;
  let firstTouch = 0;
  let followUp = 0;
  let waitingNew = 0;
  let waitingFollowUp = 0;
  const finishedToday: DigestCampaign[] = [];
  const paused: DigestCampaign[] = [];
  for (const row of campaigns) {
    if (String(row.status ?? "ACTIVE").toUpperCase() === "PAUSED") {
      paused.push(row);
    }
    sent += row.sent;
    bounced += Math.max(0, row.bounced);
    const split = classifyTodaySends(row);
    firstTouch += split.firstTouch;
    followUp += split.followUp;
    waitingNew += Math.max(0, row.notStarted);
    waitingFollowUp += Math.max(0, row.inProgress);
    if (row.sent > 0 && row.remaining <= 0 && row.notStarted <= 0 && row.inProgress <= 0) {
      finishedToday.push(row);
    }
  }
  return { sent, bounced, firstTouch, followUp, waitingNew, waitingFollowUp, finishedToday, paused };
}

export function rollupClients(campaigns: DigestCampaign[]): ClientDigest[] {
  const groups = new Map<string, DigestCampaign[]>();
  for (const campaign of campaigns) {
    if (String(campaign.status ?? "ACTIVE").toUpperCase() === "PAUSED") continue;
    const list = groups.get(campaign.clientName) ?? [];
    list.push(campaign);
    groups.set(campaign.clientName, list);
  }

  return [...groups.entries()]
    .map(([clientName, rows]) => buildClient(clientName, rows))
    .filter((row) => row.severity !== "quiet")
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.clientName.localeCompare(b.clientName));
}

export function formatDailyDigest(
  day: string,
  campaigns: DigestCampaign[],
  bounceWarn = 5,
): string | null {
  if (!campaigns.length) return null;
  const totals = digestTotals(campaigns);
  const lines = [
    `*${formatDayLabel(day)}*`,
    `*${totals.sent.toLocaleString()} sent today* (${totals.firstTouch.toLocaleString()} new · ${totals.followUp.toLocaleString()} follow-up)${bounceSuffix(totals.sent, totals.bounced, bounceWarn)}`,
    `Still waiting: ${totals.waitingNew.toLocaleString()} new · ${totals.waitingFollowUp.toLocaleString()} follow-up`,
    `Paused: ${formatNameList(totals.paused)}`,
    `Finished today: ${formatNameList(totals.finishedToday, 6)}`,
  ];

  const groups = new Map<string, DigestCampaign[]>();
  for (const campaign of campaigns) {
    const list = groups.get(campaign.clientName) ?? [];
    list.push(campaign);
    groups.set(campaign.clientName, list);
  }

  const clients = [...groups.entries()]
    .map(([clientName, rows]) => ({
      clientName,
      rows,
      sent: rows.reduce((sum, row) => sum + row.sent, 0),
      bounced: rows.reduce((sum, row) => sum + row.bounced, 0),
      leftover: rows.reduce((sum, row) => sum + row.remaining, 0),
      paused: rows.some((row) => String(row.status ?? "").toUpperCase() === "PAUSED"),
    }))
    .filter((client) => client.sent > 0 || client.leftover >= 10 || client.paused)
    .sort((a, b) => b.sent - a.sent || a.clientName.localeCompare(b.clientName));

  for (const client of clients) {
    const firstTouch = client.rows.reduce((sum, row) => sum + classifyTodaySends(row).firstTouch, 0);
    const followUp = client.rows.reduce((sum, row) => sum + classifyTodaySends(row).followUp, 0);
    lines.push("");
    lines.push(
      `*${client.clientName}* — ${formatClientVolume(client.sent, firstTouch, followUp)}${bounceSuffix(client.sent, client.bounced, bounceWarn)}`,
    );
    const campaignsToShow = [...client.rows]
      .filter(
        (row) =>
          row.sent > 0 ||
          row.remaining >= 10 ||
          String(row.status ?? "").toUpperCase() === "PAUSED",
      )
      .sort((a, b) => {
        const pausedA = String(a.status ?? "").toUpperCase() === "PAUSED" ? 0 : 1;
        const pausedB = String(b.status ?? "").toUpperCase() === "PAUSED" ? 0 : 1;
        return pausedA - pausedB || b.sent - a.sent || a.campaignName.localeCompare(b.campaignName);
      });
    for (const row of campaignsToShow) {
      lines.push(`• ${campaignLine(client.clientName, row, bounceWarn)}`);
    }
  }

  return lines.join("\n");
}

export function formatPauseMessage(input: {
  clientName: string;
  campaignName: string;
  autobounce: boolean;
  bounceRate: number | null;
  sent: number | null;
  reason: string;
}): string {
  const who = `*${input.clientName}* — *${input.campaignName}*`;
  if (input.autobounce) {
    const bounce =
      input.bounceRate != null
        ? `autobounce, ${input.bounceRate.toFixed(1)}% bounce` +
          (input.sent != null ? ` on ${input.sent.toLocaleString()} sends` : "")
        : "Smartlead autobounce";
    return `${who} paused (${bounce}).`;
  }
  return `${who} paused.`;
}

export function formatFinishedMessage(input: {
  clientName: string;
  campaignName: string;
}): string {
  return `*${input.clientName}* — *${input.campaignName}* finished the list.`;
}

function buildClient(clientName: string, rows: DigestCampaign[]): ClientDigest {
  const sent = rows.reduce((sum, row) => sum + row.sent, 0);
  const firstTouch = rows.reduce((sum, row) => sum + classifyTodaySends(row).firstTouch, 0);
  const followUp = rows.reduce((sum, row) => sum + classifyTodaySends(row).followUp, 0);
  const understaffed =
    rows.length > 0 &&
    rows.every((row) => row.attached > 0 && row.staffable <= 1) &&
    rows.some((row) => row.remaining >= 10);
  const stalled = rows.filter(
    (row) =>
      row.remaining >= 10 &&
      (row.shouldAlert || (row.sent <= 2 && row.staffable >= 3)),
  );
  const noInbox = rows.filter((row) => row.attached === 0 && row.remaining >= 10);

  const volume = formatClientVolume(sent, firstTouch, followUp);
  const flags: string[] = [];
  if (understaffed) flags.push("1 inbox on every campaign");

  const callouts = [
    ...stalled.map((row) => leftoverCallout(clientName, row)),
    ...noInbox
      .filter((row) => !stalled.includes(row))
      .map(
        (row) =>
          `*${shortCampaignName(clientName, row.campaignName)}* has no inbox (${row.remaining.toLocaleString()} left)`,
      ),
  ];
  if (callouts.length >= 3 && stalled.every((row) => row.sent <= 2)) {
    const leftovers = stalled.map((row) => row.remaining);
    const biggest = [...stalled].sort((a, b) => b.remaining - a.remaining)[0];
    flags.push(
      `${stalled.length} campaigns sent 0 with ${Math.min(...leftovers).toLocaleString()}–${Math.max(...leftovers).toLocaleString()} left` +
        (biggest
          ? `. Biggest: *${shortCampaignName(clientName, biggest.campaignName)}* ${biggest.remaining.toLocaleString()}`
          : ""),
    );
  } else if (callouts.length) {
    flags.push(callouts.join("; "));
  }

  const hasProblem = understaffed || stalled.length > 0 || noInbox.length > 0;
  const leftover = rows.reduce((sum, row) => sum + row.remaining, 0);
  if (!hasProblem && sent <= 0 && leftover < 10) {
    return { clientName, severity: "quiet", line: `*${clientName}* — ${volume}.` };
  }

  const extra = flags.length ? `. ${flags.join(". ")}` : "";
  return {
    clientName,
    severity: hasProblem ? "problem" : "fine",
    line: `*${clientName}* — ${volume}${extra}.`,
  };
}

function campaignLine(clientName: string, row: DigestCampaign, bounceWarn: number): string {
  const name = shortCampaignName(clientName, row.campaignName);
  const paused = String(row.status ?? "").toUpperCase() === "PAUSED";
  const split = classifyTodaySends(row);
  const mix =
    row.sent <= 0
      ? "0 sent"
      : split.firstTouch > 0 && split.followUp > 0
        ? `${row.sent.toLocaleString()} sent (${split.firstTouch.toLocaleString()} new · ${split.followUp.toLocaleString()} follow-up)`
        : split.firstTouch > 0
          ? `${row.sent.toLocaleString()} sent, all new`
          : `${row.sent.toLocaleString()} sent, all follow-up`;
  const waiting =
    row.sent <= 0 && row.remaining > 0
      ? row.notStarted > 0 && row.inProgress === 0
        ? `${row.notStarted.toLocaleString()} new waiting`
        : row.notStarted === 0 && row.inProgress > 0
          ? `${row.inProgress.toLocaleString()} follow-ups waiting`
          : `${row.remaining.toLocaleString()} waiting`
      : "";
  const parts = [paused ? `${name} — paused` : `${name} — ${mix}`];
  if (paused && row.sent > 0) parts.push(mix);
  if (waiting) parts.push(waiting);
  const bounce = bounceSuffix(row.sent, row.bounced, bounceWarn);
  if (bounce) parts.push(bounce.replace(/^ · /, ""));
  return parts[0] + (parts.length > 1 ? ` · ${parts.slice(1).join(" · ")}` : "");
}

function bounceSuffix(sent: number, bounced: number, bounceWarn: number): string {
  const pct = bouncePercent(sent, bounced);
  if (pct == null) return "";
  const label = `${pct.toFixed(1)}% bounce`;
  return ` · ${pct + 1e-9 >= bounceWarn ? `*${label}*` : label}`;
}

function formatClientVolume(sent: number, firstTouch: number, followUp: number): string {
  if (sent <= 0) return "0 sent";
  if (firstTouch > 0 && followUp > 0) {
    return `${sent.toLocaleString()} sent (${firstTouch.toLocaleString()} new · ${followUp.toLocaleString()} follow-up)`;
  }
  if (firstTouch > 0) return `${sent.toLocaleString()} sent, all new`;
  return `${sent.toLocaleString()} sent, all follow-up`;
}

function leftoverCallout(clientName: string, row: DigestCampaign): string {
  const who = `*${shortCampaignName(clientName, row.campaignName)}*`;
  if (row.staffable <= 0) return `${who} has no inbox (${row.remaining.toLocaleString()} left)`;
  const kind =
    row.notStarted > 0 && row.inProgress === 0
      ? `${row.notStarted.toLocaleString()} new waiting`
      : row.notStarted === 0 && row.inProgress > 0
        ? `${row.inProgress.toLocaleString()} follow-ups waiting`
        : `${row.remaining.toLocaleString()} waiting`;
  return `${who} ${row.sent} sent, ${kind}`;
}

function formatNameList(rows: DigestCampaign[], limit?: number): string {
  if (!rows.length) return "none";
  const shown = limit != null ? rows.slice(0, limit) : rows;
  return (
    shown
      .map((row) => `*${row.clientName}* ${shortCampaignName(row.clientName, row.campaignName)}`)
      .join("; ") + (limit != null && rows.length > limit ? ` +${rows.length - limit} more` : "")
  );
}

function formatDayLabel(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  return `${weekday} ${month}/${day}`;
}

function rank(severity: ClientDigest["severity"]): number {
  if (severity === "problem") return 0;
  if (severity === "fine") return 1;
  return 2;
}
