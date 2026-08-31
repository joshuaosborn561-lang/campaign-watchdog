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

/** Smartlead canary / probe copies. Never Slack or report these. */
export function isCanaryShell(name: string): boolean {
  return /canary[\s_-]*shell/i.test(name) || /^canary\b/i.test(name);
}

/** Word-hunt control copies. Same treatment as canary shells. */
export function isWordHuntShell(name: string): boolean {
  return /word[\s_-]*hunt[\s_-]*shell/i.test(name) || /^word[\s_-]*hunt\b/i.test(name);
}

export function isNoiseCampaign(name: string): boolean {
  return (
    isCanaryShell(name) ||
    isWordHuntShell(name) ||
    /pod control[\s_-]*shell/i.test(name)
  );
}

export function isGenericCampaign(name: string): boolean {
  return /\bgeneric\b/i.test(name);
}

/** Completion / refill Slack ignores shells and Generic pools. */
export function isCompletionIgnoredCampaign(name: string): boolean {
  return isNoiseCampaign(name) || isGenericCampaign(name);
}
