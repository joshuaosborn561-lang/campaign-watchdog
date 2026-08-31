import type { AutobounceVerdict } from "./autobounce.js";
import type { SendingDiagnosis } from "./sending.js";

export function formatClientCampaign(clientName: string, campaignName: string): string {
  return `*${clientName}* — *${campaignName}*`;
}

export function formatCompletionMessage(input: {
  clientName: string;
  campaignName: string;
  threshold: number;
  percent: number;
  contacted: number;
  total: number;
  remaining: number;
  otherActiveLeads?: boolean;
}): string {
  const who = formatClientCampaign(input.clientName, input.campaignName);
  if (input.threshold >= 100) {
    const done = `${who} finished the list.`;
    if (input.otherActiveLeads) {
      return `${done} This client still has other active campaigns with leads left.`;
    }
    return `${done} This client now has nothing sending — flag for a lead refill.`;
  }
  return `${who} is nearly done (${input.threshold}%, ${input.remaining.toLocaleString()} left). Refill soon.`;
}

export function formatAutobounceMessage(input: {
  clientName: string;
  campaignName: string;
  verdict: AutobounceVerdict;
}): string {
  const who = formatClientCampaign(input.clientName, input.campaignName);
  const bounce =
    input.verdict.bounceRate != null
      ? `Bounce rate ${input.verdict.bounceRate.toFixed(1)}%` +
        (input.verdict.sent != null ? ` on ${input.verdict.sent.toLocaleString()} sends` : "") +
        `.`
      : "Bounce rate unavailable.";
  return `${who} paused because of Smartlead autobounce. ${bounce} ${input.verdict.reason}.`;
}

export function formatSendingMessage(input: {
  clientName: string;
  campaignName: string;
  day: string;
  diagnosis: SendingDiagnosis;
}): string {
  const who = formatClientCampaign(input.clientName, input.campaignName);
  const bullets = input.diagnosis.receipts.map((line) => `• ${line}`).join("\n");
  return [
    `${who} sent ${input.diagnosis.sent.toLocaleString()} on ${input.day}. ${input.diagnosis.reason}`,
    bullets,
  ].join("\n");
}
