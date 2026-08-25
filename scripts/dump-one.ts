import { SmartleadClient } from "../src/clients/smartlead.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) process.exit(1);
const smartlead = new SmartleadClient(apiKey);
const id = Number(process.argv[2] || 3730560);
const [campaign, stats, analytics, today] = await Promise.all([
  smartlead.getCampaign(id),
  smartlead.getCampaignStatistics(id).catch((e) => ({ error: String(e) })),
  smartlead.getCampaignAnalytics(id).catch((e) => ({ error: String(e) })),
  smartlead
    .getCampaignAnalyticsByDate(id, "2026-08-25", "2026-08-25")
    .catch((e) => ({ error: String(e) })),
]);

function keys(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = Object.keys(v as object).slice(0, 40);
    } else if (Array.isArray(v)) {
      out[k] = `array(${v.length})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

console.log("CAMPAIGN", JSON.stringify(keys(campaign), null, 2));
console.log("STATS", JSON.stringify(keys(stats), null, 2));
console.log("ANALYTICS", JSON.stringify(keys(analytics), null, 2));
console.log("TODAY", JSON.stringify(keys(today), null, 2));
