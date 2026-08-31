import { SmartleadClient } from "../src/clients/smartlead.js";
import { isGenericCampaign, isNoiseCampaign } from "../src/lib/names.js";
import { sleep } from "../src/lib/http.js";

const apiKey = process.env.SMARTLEAD_API_KEY?.trim();
if (!apiKey) process.exit(1);
const dry = process.argv.includes("--dry");
const allClients = process.argv.includes("--all");
const smartlead = new SmartleadClient(apiKey);
const campaigns = await smartlead.listCampaigns();

const paused = campaigns.filter(
  (campaign) => String(campaign.status ?? "").toUpperCase() === "PAUSED",
);
const resume = paused.filter((campaign) => {
  if (isNoiseCampaign(campaign.name) || isGenericCampaign(campaign.name)) return false;
  if (!allClients && !/^BCP\b/i.test(campaign.name)) return false;
  return true;
});
const skip = paused.filter((campaign) => !resume.includes(campaign));

console.log(`paused ${paused.length} · resume ${resume.length} · leave ${skip.length}`);
for (const campaign of skip) {
  console.log("LEAVE", campaign.status, `#${campaign.id}`, campaign.name);
}
for (const campaign of resume) {
  if (dry) {
    console.log("WOULD START", `#${campaign.id}`, campaign.name);
    continue;
  }
  try {
    const result = await smartlead.updateCampaignStatus(campaign.id, "START");
    console.log("STARTED", `#${campaign.id}`, campaign.name, JSON.stringify(result).slice(0, 200));
  } catch (error) {
    console.error("FAIL", `#${campaign.id}`, campaign.name, error instanceof Error ? error.message : error);
  }
  await sleep(200);
}
