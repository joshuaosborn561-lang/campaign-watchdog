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

/** Smartlead canary / probe copies. Never Slack these. */
export function isNoiseCampaign(name: string): boolean {
  return /canary\s*shell/i.test(name) || /^canary\b/i.test(name);
}

export function isGenericCampaign(name: string): boolean {
  return /\bgeneric\b/i.test(name);
}
