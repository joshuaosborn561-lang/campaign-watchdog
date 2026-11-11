import { SmartleadClient } from "../src/clients/smartlead.js";
import { resolveClient } from "../src/lib/clients.js";
import { isNoiseCampaign } from "../src/lib/names.js";
import {
  formatClientPulse,
  isPulseExcludedCampaign,
  parseTodayVolume,
  rollupClientPulse,
} from "../src/lib/pulse.js";
import { hourInZone, ymdInZone } from "../src/lib/time.js";
import { sleep } from "../src/lib/http.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) {
  console.error("SMARTLEAD_API_KEY missing");
  process.exit(1);
}

const timeZone = "America/Chicago";
const now = new Date();
const day = ymdInZone(now, timeZone);
const hour = hourInZone(now, timeZone);
const smartlead = new SmartleadClient(apiKey);
const campaigns = await smartlead.listCampaigns();
const clients = await smartlead.listClients().catch(() => []);
const clientsById = new Map(clients.map((c) => [c.id, c]));
// Same resolver as the service: sg-owner tag → owner catalog, then client_id. No Supabase here.
const ownerOf = (campaign: (typeof campaigns)[number]) =>
  resolveClient(campaign, clientsById, new Map(), new Map());
const rows: Array<{ clientId: number | null; clientName: string; sent: number; bounced: number }> = [];

for (const campaign of campaigns) {
  const status = String(campaign.status ?? "").toUpperCase();
  if (isNoiseCampaign(campaign.name) || isPulseExcludedCampaign(campaign)) continue;
  if (status !== "ACTIVE" && status !== "PAUSED") continue;
  try {
    const today = await smartlead.getCampaignAnalyticsByDate(campaign.id, day, day);
    const volume = parseTodayVolume(today, day);
    const owner = ownerOf(campaign);
    rows.push({
      clientId: owner.clientId,
      clientName: owner.clientName,
      sent: volume.sent,
      bounced: volume.bounced,
    });
  } catch (error) {
    console.warn(campaign.name, error instanceof Error ? error.message : error);
  }
  await sleep(80);
}

const rolled = rollupClientPulse(rows);
console.log(
  formatClientPulse({
    day,
    hour,
    clients: rolled,
    bounceWarn: 5,
  }),
);
