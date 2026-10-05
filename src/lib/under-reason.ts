/** More than 10% under the 1,200-send day — keep independent of volume.ts. */
const DEFAULT_ALERT_MAX = 1080;
const LOW_LEAD_REMAINING = 10;
const DEFAULT_BOUNCE_WARN = 5;
const DEFAULT_BOUNCE_SAMPLE = 20;
/** Same floor as pulse CANON_MIN_SENDERS — exclusive senders on an ACTIVE list. */
const CANON_MIN_SENDERS = 40;

export const UNDER_REASON_FALLBACK = "pace short of 1,200";

export type UnderReasonKind =
  | "leads"
  | "inboxes"
  | "bounce"
  | "paused"
  | "caps"
  | "schedule"
  | "pace";

export interface UnderReasonSignals {
  sent: number;
  remaining?: number | null;
  bounced?: number;
  attached?: number | null;
  staffable?: number | null;
  disconnected?: number | null;
  pausedCampaigns?: number;
  activeCampaigns?: number;
  bounceHold?: boolean;
  bounceWarn?: number;
  minBounceSample?: number;
  maxLeadsPerDay?: number | null;
  outsideWindow?: boolean;
  alertMax?: number;
}

export interface UnderReason {
  kind: UnderReasonKind;
  text: string;
}

/**
 * Single primary cause for a client-level *under* flag.
 * Priority: hopper too thin to hit the day → inbox staffing → bounce hold →
 * paused lists → daily cap → outside the send window → pace fallback.
 */
export function explainUnderVolume(input: UnderReasonSignals): UnderReason {
  const alertMax = input.alertMax ?? DEFAULT_ALERT_MAX;
  const remaining = finiteOrNull(input.remaining);
  const attached = finiteOrNull(input.attached);
  const staffable = finiteOrNull(input.staffable);
  const disconnected =
    finiteOrNull(input.disconnected) ??
    (attached != null && staffable != null ? Math.max(0, attached - staffable) : null);
  const bounced = Math.max(0, input.bounced ?? 0);
  const sent = Math.max(0, input.sent);
  const bounceRate = sent > 0 ? (bounced / sent) * 100 : null;
  const bounceWarn = input.bounceWarn ?? DEFAULT_BOUNCE_WARN;
  const minSample = input.minBounceSample ?? DEFAULT_BOUNCE_SAMPLE;
  const paused = Math.max(0, input.pausedCampaigns ?? 0);
  const active = Math.max(0, input.activeCampaigns ?? 0);
  const cap = finiteOrNull(input.maxLeadsPerDay);

  if (
    remaining != null &&
    (remaining <= 0 || remaining < LOW_LEAD_REMAINING || sent + remaining < alertMax)
  ) {
    return {
      kind: "leads",
      text:
        remaining <= 0
          ? "no leads left on ACTIVE lists"
          : "too few leads on ACTIVE lists",
    };
  }

  const smtpDown =
    attached != null &&
    attached >= 5 &&
    (disconnected ?? 0) > 0 &&
    (staffable ?? 0) <= Math.max(1, Math.floor(attached * 0.3));
  if (smtpDown) {
    return { kind: "inboxes", text: "most campaign inboxes SMTP/IMAP down" };
  }
  const inboxCount = attached ?? staffable;
  if (inboxCount != null && inboxCount < CANON_MIN_SENDERS) {
    return {
      kind: "inboxes",
      text:
        inboxCount <= 0
          ? "no campaign inboxes linked"
          : `only ~${inboxCount} campaign inboxes linked`,
    };
  }

  const bounceHold =
    Boolean(input.bounceHold) ||
    (bounceRate != null && sent >= minSample && bounceRate + 1e-9 >= bounceWarn);
  if (bounceHold) {
    return {
      kind: "bounce",
      text:
        bounceRate != null && bounceRate > 0
          ? `bounce hold (${bounceRate.toFixed(1)}%)`
          : "bounce rate / bounce hold",
    };
  }

  if (paused > 0 && (active <= 0 || paused >= active)) {
    return {
      kind: "paused",
      text: paused === 1 ? "paused campaigns" : `${paused} campaigns paused`,
    };
  }

  if (cap != null && cap > 0 && (cap < alertMax || sent >= Math.floor(cap * 0.85))) {
    return { kind: "caps", text: "daily send cap hitting" };
  }

  if (input.outsideWindow) {
    return { kind: "schedule", text: "outside send window" };
  }

  return { kind: "pace", text: UNDER_REASON_FALLBACK };
}

/** ` · *under* — too few leads on ACTIVE lists` */
export function formatUnderFlag(under: boolean, reason?: string | null): string {
  if (!under) return "";
  const phrase = (reason ?? "").trim() || UNDER_REASON_FALLBACK;
  return ` · *under* — ${phrase}`;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
