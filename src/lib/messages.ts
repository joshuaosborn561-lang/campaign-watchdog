import type { AutobounceVerdict } from "./autobounce.js";
import type { SendingShortfall } from "./sending.js";

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
}): string {
  const done = input.threshold >= 100;
  const headline = done
    ? `${formatClientCampaign(input.clientName, input.campaignName)} is at 100% completion.`
    : `${formatClientCampaign(input.clientName, input.campaignName)} is at ${input.threshold}% completion.`;
  const detail = done
    ? `${input.contacted.toLocaleString()} / ${input.total.toLocaleString()} leads contacted.`
    : `${input.percent.toFixed(1)}% through the list (${input.contacted.toLocaleString()} / ${input.total.toLocaleString()} contacted, ${input.remaining.toLocaleString()} left).`;
  return [headline, detail].join(" ");
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
  shortfall: SendingShortfall;
}): string {
  const who = formatClientCampaign(input.clientName, input.campaignName);
  return [
    `${who} is under ${input.shortfall.perInboxTarget} sends/day/inbox for ${input.day}.`,
    `Sent ${input.shortfall.sent.toLocaleString()} of ${input.shortfall.expected.toLocaleString()} expected`,
    `(${input.shortfall.inboxCount} inbox${input.shortfall.inboxCount === 1 ? "" : "es"} × ${input.shortfall.perInboxTarget}).`,
    `Short by ${input.shortfall.shortBy.toLocaleString()}.`,
  ].join(" ");
}
