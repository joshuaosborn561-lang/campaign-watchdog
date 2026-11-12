/**
 * Read-only: today's per-client sent counts exactly as the pulse computes them
 * (one day-wise call per client over all non-draft lists, sg-owner resolver),
 * plus an account-wide day-wise cross-check. Posts nothing, changes nothing.
 *
 *   SMARTLEAD_API_KEY=… npx tsx scripts/pulse-today.ts [YYYY-MM-DD] [--recount=<owner name substring>,…]
 *
 * --recount re-reads the named clients one campaign at a time with
 * analytics-by-date (slow; paced by SMARTLEAD_MIN_INTERVAL_MS).
 */
import { SmartleadClient, isCountableCampaignStatus } from "../src/clients/smartlead.js";
import { clientGroupKey, resolveClient } from "../src/lib/clients.js";
import {
  DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS,
  DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES,
  formatClientPulse,
  parseTodayVolume,
  rollupClientPulse,
} from "../src/lib/pulse.js";
import { countSentTodayByClient } from "../src/lib/sent-today.js";
import { hourInZone, ymdInZone } from "../src/lib/time.js";
import { isVolumeSkippedCampaign } from "../src/lib/volume.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) {
  console.error("SMARTLEAD_API_KEY missing");
  process.exit(1);
}

const args = process.argv.slice(2);
const timeZone = "America/Chicago";
const now = new Date();
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? ymdInZone(now, timeZone);
const recount = (args.find((a) => a.startsWith("--recount="))?.slice(10) ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const hour = hourInZone(now, timeZone);
const mute = { ids: DEFAULT_PULSE_EXCLUDE_CAMPAIGN_IDS, names: DEFAULT_PULSE_EXCLUDE_CAMPAIGN_NAMES };
const smartlead = new SmartleadClient(apiKey);
const campaigns = await smartlead.listCampaigns();
const clients = await smartlead.listClients().catch(() => []);
const clientsById = new Map(clients.map((c) => [c.id, c]));
const ownerOf = (campaign: (typeof campaigns)[number]) =>
  resolveClient(campaign, clientsById, new Map(), new Map());

const counted: Array<{ id: number; name: string; clientId: number | null; clientName: string }> = [];
const notCounted: number[] = [];
const liveKeys = new Set<string>();
for (const campaign of campaigns) {
  if (isVolumeSkippedCampaign(campaign, mute) || !isCountableCampaignStatus(campaign.status)) {
    notCounted.push(campaign.id);
    continue;
  }
  const owner = ownerOf(campaign);
  const status = String(campaign.status ?? "").toUpperCase();
  if (status === "ACTIVE" || status === "PAUSED") liveKeys.add(clientGroupKey(owner));
  counted.push({ id: campaign.id, name: campaign.name, clientId: owner.clientId, clientName: owner.clientName });
}

const started = Date.now();
const accountBefore = await smartlead.getAccountDayWiseTotals(day);
const result = await countSentTodayByClient({ source: smartlead, day, campaigns: counted });
const accountWide = await smartlead.getAccountDayWiseTotals(day);
const excluded = { sent: 0, bounced: 0 };
for (let i = 0; i < notCounted.length; i += 100) {
  const part = await smartlead.getDayWiseTotals(day, notCounted.slice(i, i + 100));
  excluded.sent += part.sent;
  excluded.bounced += part.bounced;
}

const rows = [...result.byKey.entries()]
  .filter(([key, row]) => liveKeys.has(key) || row.sent > 0 || row.unread > 0)
  .map(([, row]) => row);
console.log(formatClientPulse({ day, hour, clients: rollupClientPulse(rows), bounceWarn: 5 }));
const clientSum = [...result.byKey.values()].reduce((s, r) => s + r.sent, 0);
console.log("");
console.log(
  JSON.stringify(
    {
      day,
      at: new Date().toISOString(),
      campaigns: campaigns.length,
      counted: counted.length,
      notCounted: notCounted.length,
      perClientCalls: result.calls,
      bulkFailures: result.bulkFailures,
      seconds: Math.round((Date.now() - started) / 1000),
      clientSum,
      excludedSent: excluded.sent,
      accountWideBefore: accountBefore.sent,
      accountWideSent: accountWide.sent,
      diff: accountWide.sent - clientSum - excluded.sent,
      inBracket:
        clientSum + excluded.sent >= accountBefore.sent && clientSum + excluded.sent <= accountWide.sent,
      perClient: [...result.byKey.values()].map((r) => ({
        client: r.clientName,
        id: r.clientId,
        campaigns: r.campaigns,
        sent: r.sent,
        bounced: r.bounced,
        unread: r.unread,
      })),
    },
    null,
    2,
  ),
);

for (const needle of recount) {
  const mine = counted.filter((c) => c.clientName.toLowerCase().includes(needle));
  let sent = 0;
  let failed = 0;
  for (const c of mine) {
    try {
      sent += parseTodayVolume(await smartlead.getCampaignAnalyticsByDate(c.id, day, day), day).sent;
    } catch {
      failed += 1;
    }
  }
  const bulk = [...result.byKey.values()]
    .filter((r) => r.clientName.toLowerCase().includes(needle))
    .reduce((s, r) => s + r.sent, 0);
  console.log(
    `recount ${needle}: per-campaign ${sent} over ${mine.length} campaigns (${failed} failed) vs day-wise ${bulk}`,
  );
}
