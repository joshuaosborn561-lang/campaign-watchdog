import { SmartleadClient } from "../src/clients/smartlead.js";
import { isNoiseCampaign } from "../src/lib/names.js";
import { parseTodayVolume, rollupClientPulse, formatClientPulse } from "../src/lib/pulse.js";
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
const clientName = new Map(clients.map((c) => [c.id, c.logo?.trim() || c.name || `Client ${c.id}`]));
const rows: Array<{ clientName: string; sent: number; bounced: number }> = [];

for (const campaign of campaigns) {
  const status = String(campaign.status ?? "").toUpperCase();
  if (isNoiseCampaign(campaign.name)) continue;
  if (status !== "ACTIVE" && status !== "PAUSED") continue;
  try {
    const today = await smartlead.getCampaignAnalyticsByDate(campaign.id, day, day);
    const volume = parseTodayVolume(today, day);
    rows.push({
      clientId: campaign.client_id ?? null,
      clientName:
        (campaign.client_id && clientName.get(campaign.client_id)) || "Unknown client",
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
