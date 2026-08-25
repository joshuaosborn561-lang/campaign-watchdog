import { SmartleadClient } from "../src/clients/smartlead.js";
import { parseCampaignLeadStats } from "../src/lib/completion.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) process.exit(1);
const smartlead = new SmartleadClient(apiKey);
const names = (process.argv[2] || "TechEvo New England Red Sox,Parlay EOS Sales DM Choice,Goliath Displacement L,SalesGlider Staffing Airpods Only").split(",");

function summarize(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { raw };
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { keys: Object.keys(row) };
  for (const key of [
    "total_count",
    "drafted_count",
    "sent_count",
    "unique_sent_count",
    "total_leads",
    "not_started",
    "contacted",
    "leads_contacted",
    "campaign_lead_stats",
    "lead_stats",
  ]) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

const campaigns = await smartlead.listCampaigns();
for (const campaign of campaigns) {
  if (!names.some((name) => campaign.name.includes(name.trim()))) continue;
  const [lifetime, today, statistics] = await Promise.all([
    smartlead.getCampaignAnalytics(campaign.id),
    smartlead.getCampaignAnalyticsByDate(campaign.id, "2026-08-25", "2026-08-25"),
    smartlead.getCampaignStatistics(campaign.id).catch(() => null),
  ]);
  console.log("\n===", campaign.id, campaign.name, "===");
  console.log("lifetime", JSON.stringify(summarize(lifetime)));
  console.log("parsed lifetime", parseCampaignLeadStats(lifetime));
  console.log("today", JSON.stringify(summarize(today)));
  console.log("parsed today", parseCampaignLeadStats(today));
  console.log("parsed stats", parseCampaignLeadStats(statistics));
}
