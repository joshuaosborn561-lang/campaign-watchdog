import { asNumber, pickNumber, pickString, unwrap } from "./parse.js";

export interface AutobounceVerdict {
  paused: boolean;
  autobounce: boolean;
  bounceRate: number | null;
  bounceCount: number | null;
  sent: number | null;
  threshold: number;
  reason: string;
}

const AUTOBOUNCE_HINT =
  /auto[-_\s]?bounce|bounce[-_\s]?auto[-_\s]?pause|auto[-_\s]?paused?\b[^.]{0,40}bounce|paused?\b[^.]{0,40}auto[-_\s]?bounce|bounce_auto_pause/i;

export function parseBounceAutoPauseThreshold(
  raw: unknown,
  fallback: number,
): number {
  const root = unwrap(raw);
  if (!root) return fallback;
  return (
    pickNumber(root, [
      "bounce_auto_pause_threshold",
      "bounceAutoPauseThreshold",
      "auto_pause_bounce_threshold",
      "auto_bounce_threshold",
    ]) ?? fallback
  );
}

export function bounceRateFrom(raw: unknown): {
  bounceRate: number | null;
  bounceCount: number | null;
  sent: number | null;
} {
  const root = unwrap(raw);
  if (!root) {
    return { bounceRate: null, bounceCount: null, sent: null };
  }
  const sent = pickNumber(root, ["sent_count", "sent", "total_sent", "emails_sent"]);
  const bounceCount = pickNumber(root, [
    "bounce_count",
    "bounces",
    "total_bounced",
    "bounced",
  ]);
  const computed =
    sent && sent > 0 && bounceCount != null ? (bounceCount / sent) * 100 : null;
  const explicit = pickNumber(root, ["bounce_rate", "bounceRate"]);
  const bounceRate =
    computed ??
    (explicit != null ? (explicit > 0 && explicit <= 1 ? explicit * 100 : explicit) : null);
  return { bounceRate, bounceCount: bounceCount ?? null, sent: sent ?? null };
}

export function detectAutobounce(input: {
  status: string;
  campaign?: unknown;
  settings?: unknown;
  analytics?: unknown;
  fallbackThreshold: number;
  minSample: number;
}): AutobounceVerdict {
  const paused = String(input.status ?? "").toUpperCase() === "PAUSED";
  const threshold = parseBounceAutoPauseThreshold(input.settings ?? input.campaign, input.fallbackThreshold);
  const fromAnalytics = bounceRateFrom(input.analytics);
  const fromCampaign = bounceRateFrom(input.campaign);
  const bounceRate = fromAnalytics.bounceRate ?? fromCampaign.bounceRate;
  const bounceCount = fromAnalytics.bounceCount ?? fromCampaign.bounceCount;
  const sent = fromAnalytics.sent ?? fromCampaign.sent;

  const campaign = unwrap(input.campaign) ?? {};
  const pauseReason = pickString(campaign, [
    "pause_reason",
    "paused_reason",
    "auto_pause_reason",
    "status_reason",
  ]);
  const hintText = [pauseReason, pickString(campaign, ["status_message", "message"])]
    .filter(Boolean)
    .join(" ");
  const hinted = AUTOBOUNCE_HINT.test(hintText);
  const reasonHint = pauseReason
    ? AUTOBOUNCE_HINT.test(pauseReason) || /bounce/i.test(pauseReason)
    : false;
  const autoPausedFlag = Boolean(
    unwrap(input.campaign)?.auto_paused ??
      unwrap(input.campaign)?.auto_pause ??
      unwrap(input.settings)?.auto_paused,
  );

  const overThreshold =
    bounceRate != null &&
    sent != null &&
    sent >= input.minSample &&
    bounceRate + 1e-9 >= threshold;

  const autobounce = paused && (hinted || reasonHint || (autoPausedFlag && overThreshold) || overThreshold);

  let reason = "not paused";
  if (paused && hinted) reason = "Smartlead marked this pause as autobounce";
  else if (paused && reasonHint && pauseReason) reason = `pause reason: ${pauseReason}`;
  else if (paused && overThreshold) {
    reason = `bounce rate ${formatPct(bounceRate)} hit the ${formatPct(threshold)} autobounce threshold`;
  } else if (paused) reason = "paused, but bounce data does not look like autobounce";

  return {
    paused,
    autobounce,
    bounceRate,
    bounceCount,
    sent,
    threshold,
    reason,
  };
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "?%";
  return `${value.toFixed(1)}%`;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return asNumber(value);
}
