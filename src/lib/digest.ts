import type { SendingKind } from "./sending.js";

export interface DigestCampaign {
  clientName: string;
  campaignName: string;
  sent: number;
  remaining: number;
  notStarted: number;
  inProgress: number;
  staffable: number;
  attached: number;
  kind: SendingKind | "unknown";
  shouldAlert: boolean;
}

export interface ClientDigest {
  clientName: string;
  severity: "problem" | "fine" | "quiet";
  line: string;
}

export function shortCampaignName(clientName: string, campaignName: string): string {
  let name = campaignName.trim();
  const prefixes = [
    clientName,
    ...clientName.split(/[\s/]+/).filter((part) => part.length > 3),
    "TechEvo",
    "TechEvolution",
    "Peterson",
    "Roofs by Peterson",
    "Vasco Warranty",
    "Vasco",
    "Goliath Cybersecurity",
    "Goliath",
    "Parlay Tech",
    "Parlay2",
    "Parlay",
    "SalesGlider",
    "Bolder Cyber Partners",
    "BCP",
    "Culture Fits",
    "TJ",
  ];
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(`^${escaped}[\\s\\-–:]+`, "i"), "");
  }
  name = name.replace(/^[\s\-–:]+/, "").replace(/\s+/g, " ").trim();
  return name || campaignName;
}

export function rollupClients(campaigns: DigestCampaign[]): ClientDigest[] {
  const groups = new Map<string, DigestCampaign[]>();
  for (const campaign of campaigns) {
    const list = groups.get(campaign.clientName) ?? [];
    list.push(campaign);
    groups.set(campaign.clientName, list);
  }

  return [...groups.entries()]
    .map(([clientName, rows]) => buildClient(clientName, rows))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.clientName.localeCompare(b.clientName));
}

export function formatDailyDigest(day: string, clients: ClientDigest[]): string | null {
  const problems = clients.filter((row) => row.severity === "problem");
  const fine = clients.filter((row) => row.severity === "fine");
  if (!problems.length && !fine.length) return null;

  const lines = [`*${formatDayLabel(day)}*`];
  for (const row of problems) lines.push(row.line);
  if (fine.length) {
    lines.push("*Fine*");
    for (const row of fine) lines.push(row.line);
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
  const understaffed =
    rows.length > 0 &&
    rows.every((row) => row.attached > 0 && row.staffable <= 1) &&
    rows.some((row) => row.remaining >= 10);
  const stalled = rows.filter(
    (row) =>
      row.shouldAlert ||
      (row.sent <= 2 && row.remaining >= 10 && row.staffable >= 3),
  );
  const noInbox = rows.filter((row) => row.attached === 0 && row.remaining >= 5);
  const dripping = rows.filter(
    (row) =>
      !row.shouldAlert &&
      row.sent >= 8 &&
      row.sent <= 40 &&
      row.remaining >= 50 &&
      row.staffable >= 5,
  );
  const sending = rows.filter((row) => row.sent >= 8 && row.staffable >= 5 && !row.shouldAlert);
  const gapLimited = rows.filter((row) => row.kind === "ok_gap_limited");

  const parts: string[] = [];

  if (understaffed) {
    parts.push("1 inbox on every campaign");
    const worst = [...rows]
      .filter((row) => row.remaining >= 10 && row.sent <= 2)
      .sort((a, b) => a.sent - b.sent || b.remaining - a.remaining)
      .slice(0, 3)
      .map((row) => campaignReceipt(clientName, row));
    if (worst.length) parts.push(worst.join("; "));
    if (gapLimited.length) {
      parts.push(
        `${shortCampaignName(clientName, gapLimited[0].campaignName)} hit the gap cap (${gapLimited[0].sent} sent)`,
      );
    }
  } else {
    if (dripping.length && stalled.length) {
      const sends = dripping.map((row) => row.sent);
      parts.push(`new campaigns dripped ${Math.min(...sends)}–${Math.max(...sends)}`);
    } else if (dripping.length && !stalled.length && dripping.length === rows.length) {
      const sends = dripping.map((row) => row.sent);
      parts.push(`dripped ${Math.min(...sends)}–${Math.max(...sends)}`);
    } else if (sending.length && !stalled.length && !noInbox.length) {
      const sends = sending.map((row) => row.sent);
      parts.push(`sending (${Math.min(...sends)}–${Math.max(...sends)})`);
    }

    const callouts = [
      ...stalled.map((row) => {
        const who = `*${shortCampaignName(clientName, row.campaignName)}*`;
        if (row.staffable <= 0) return `${who} has no inbox (${row.remaining.toLocaleString()} in play)`;
        return `${who} ${campaignReceipt(clientName, row, false)}`;
      }),
      ...noInbox
        .filter((row) => !stalled.includes(row))
        .map(
          (row) =>
            `*${shortCampaignName(clientName, row.campaignName)}* has no inbox (${row.remaining.toLocaleString()} in play)`,
        ),
    ];
    if (callouts.length) parts.push(callouts.join("; "));
  }

  const hasProblem = understaffed || stalled.length > 0 || noInbox.length > 0;
  const hasFine =
    !hasProblem && (sending.length > 0 || dripping.length > 0 || gapLimited.length > 0);
  const leftover = rows.reduce((sum, row) => sum + row.remaining, 0);
  const sent = rows.reduce((sum, row) => sum + row.sent, 0);

  if (!parts.length) {
    if (leftover < 10 && sent <= 2) {
      return { clientName, severity: "quiet", line: `*${clientName}* — effectively done.` };
    }
    if (sent > 0) {
      return {
        clientName,
        severity: "fine",
        line: `*${clientName}* — sent ${sent.toLocaleString()}.`,
      };
    }
    return { clientName, severity: "quiet", line: `*${clientName}* — nothing due.` };
  }

  return {
    clientName,
    severity: hasProblem ? "problem" : hasFine ? "fine" : "quiet",
    line: `*${clientName}* — ${parts.join(". ")}.`,
  };
}

function campaignReceipt(
  clientName: string,
  row: DigestCampaign,
  includeName = true,
): string {
  const label = includeName ? shortCampaignName(clientName, row.campaignName) : "";
  const play =
    row.notStarted > 0 && row.inProgress === 0
      ? `${row.notStarted.toLocaleString()} new`
      : row.notStarted === 0 && row.inProgress > 0
        ? `${row.inProgress.toLocaleString()} follow-ups`
        : `${row.remaining.toLocaleString()} in play`;
  const body = `${row.sent} sent / ${play}`;
  return label ? `${label} ${body}` : body;
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
