import { SmartleadClient } from "../src/clients/smartlead.js";
import { classifyInboxes } from "../src/lib/inboxes.js";
import { parseCampaignLeadStats, parseSentCount } from "../src/lib/completion.js";
import { unwrap } from "../src/lib/parse.js";
import {
  isSendDay,
  parseCampaignSchedule,
  windowHasEnded,
} from "../src/lib/schedule.js";
import { diagnoseSending } from "../src/lib/sending.js";
import { ymdInZone } from "../src/lib/time.js";
import { sleep } from "../src/lib/http.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) {
  console.error("SMARTLEAD_API_KEY missing");
  process.exit(1);
}

const now = new Date();
const day = ymdInZone(now, "America/New_York");
const smartlead = new SmartleadClient(apiKey);

const campaigns = await smartlead.listCampaigns();
const clients = await smartlead.listClients().catch(() => []);
const clientName = new Map(clients.map((c) => [c.id, c.logo?.trim() || c.name || `Client ${c.id}`]));

type Row = {
  client: string;
  name: string;
  status: string;
  sent: number;
  remaining: number | null;
  notStarted: number | null;
  inProgress: number | null;
  staffable: number;
  attached: number;
  disconnected: number;
  cap: number | null;
  kind: string;
  reason: string;
  sendDay: boolean;
};

const rows: Row[] = [];

for (const campaign of campaigns) {
  const status = String(campaign.status ?? "").toUpperCase();
  if (status !== "ACTIVE") continue;
  try {
    const [detail, analytics, today, statistics, accounts] = await Promise.all([
      smartlead.getCampaign(campaign.id).catch(() => campaign),
      smartlead.getCampaignAnalytics(campaign.id).catch(() => null),
      smartlead.getCampaignAnalyticsByDate(campaign.id, day, day).catch(() => null),
      smartlead.getCampaignStatistics(campaign.id).catch(() => null),
      smartlead.getCampaignEmailAccounts(campaign.id).catch(() => []),
    ]);
    const stats =
      parseCampaignLeadStats(analytics) ??
      parseCampaignLeadStats(today) ??
      parseCampaignLeadStats(statistics) ??
      parseCampaignLeadStats(detail);
    const schedule = parseCampaignSchedule(unwrap(detail) ?? campaign, {
      timeZone: "America/New_York",
      gapMinutes: 10,
    });
    const inboxes = classifyInboxes(
      accounts.map((row) => ({
        id: row.id,
        email: row.from_email ?? row.email ?? row.username,
        smtpOk: row.is_smtp_success !== false,
        imapOk: row.is_imap_success !== false,
        dailySent: row.daily_sent_count ?? 0,
      })),
    );
    const sent = parseSentCount(today);
    const diagnosis = diagnoseSending({
      sent,
      remaining: stats?.remaining ?? null,
      schedule,
      inboxes,
      messagePerDay: 30,
    });
    rows.push({
      client:
        (campaign.client_id && clientName.get(campaign.client_id)) ||
        "Unknown client",
      name: campaign.name,
      status,
      sent,
      remaining: stats?.remaining ?? null,
      notStarted: stats?.notStarted ?? null,
      inProgress: stats?.inProgress ?? null,
      staffable: inboxes.staffable,
      attached: inboxes.attached,
      disconnected: inboxes.disconnected,
      cap: schedule.maxLeadsPerDay,
      kind: diagnosis?.kind ?? "unknown",
      reason: diagnosis?.reason ?? "could not diagnose (no lead totals)",
      sendDay: isSendDay(schedule, now) && windowHasEnded(schedule, now),
    });
  } catch (error) {
    rows.push({
      client: (campaign.client_id && clientName.get(campaign.client_id)) || "Unknown client",
      name: campaign.name,
      status,
      sent: -1,
      remaining: null,
      notStarted: null,
      inProgress: null,
      staffable: 0,
      attached: 0,
      disconnected: 0,
      cap: null,
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
      sendDay: false,
    });
  }
  await sleep(120);
}

const problems = rows.filter((r) =>
  ["not_staffed", "inboxes_down", "under_sending"].includes(r.kind),
);
const scheduled = rows.filter((r) => r.kind === "ok_scheduled" || r.kind === "ok_exhausted");
const fine = rows.filter((r) => r.kind === "ok_on_pace" || r.kind === "ok_gap_limited");

function line(r: Row): string {
  return [
    `${r.client} — ${r.name}`,
    `sent ${r.sent}` +
      (r.remaining != null ? `, ${r.remaining} in play` : "") +
      (r.notStarted != null || r.inProgress != null
        ? ` (new ${r.notStarted ?? 0}, follow-up ${r.inProgress ?? 0})`
        : "") +
      (r.cap != null ? `, daily cap ${r.cap}` : ""),
    `staffed ${r.staffable}/${r.attached}` +
      (r.disconnected ? ` (${r.disconnected} down)` : ""),
    r.reason,
  ].join(" | ");
}

console.log(`DAY ${day}  ACTIVE ${rows.length}`);
console.log(`\nPROBLEMS ${problems.length}`);
for (const r of problems.sort((a, b) => a.client.localeCompare(b.client) || a.sent - b.sent)) {
  console.log(line(r));
}
console.log(`\nSCHEDULED/EXHAUSTED ${scheduled.length} (not a miss)`);
for (const r of scheduled.sort((a, b) => a.client.localeCompare(b.client))) {
  console.log(line(r));
}
console.log(`\nON PACE / GAP LIMITED ${fine.length}`);
for (const r of fine.sort((a, b) => a.client.localeCompare(b.client))) {
  console.log(line(r));
}
const other = rows.filter(
  (r) =>
    !problems.includes(r) && !scheduled.includes(r) && !fine.includes(r),
);
if (other.length) {
  console.log(`\nOTHER ${other.length}`);
  for (const r of other) console.log(line(r));
}
