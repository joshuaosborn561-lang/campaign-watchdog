/** More than 10% under the 1,200-send day — keep independent of volume.ts. */
const DEFAULT_ALERT_MAX = 1080;
const LOW_LEAD_REMAINING = 10;
/** Same floor as pulse CANON_MIN_SENDERS — exclusive senders on an ACTIVE list. */
const CANON_MIN_SENDERS = 40;

export const UNDER_REASON_FALLBACK = "pace short of 1,200";

export type UnderReasonKind =
  | "leads"
  | "senders"
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
  /** Distinct senders linked to the client's ACTIVE lists. */
  sendersTotal?: number | null;
  /** Of those, senders whose sent-today reached their daily limit. */
  sendersAtCap?: number | null;
  /** Sum of sender daily limits (the most the client can send today). */
  senderDailyMax?: number | null;
  /** Sends still available today across senders (daily max − sent today). */
  capacityLeft?: number | null;
}

/** Sender-capped when this share of senders are at their daily limit. */
export const SENDER_CAP_SHARE = 0.9;

export interface UnderReason {
  kind: UnderReasonKind;
  text: string;
}

/**
 * Single primary cause for a client-level *under* flag, one sentence.
 * Priority: sender cap (≥90% of senders at daily limit) → not enough leads
 * (new leads left < remaining capacity) → bounce hold (only when a list was
 * actually auto-paused) → paused lists → disconnected / missing senders →
 * daily cap → outside send window → pace fallback.
 * A high bounce *rate* alone is never the reason — Watchdog never pauses.
 */
export function explainUnderVolume(input: UnderReasonSignals): UnderReason {
  const alertMax = input.alertMax ?? DEFAULT_ALERT_MAX;
  const remaining = finiteOrNull(input.remaining);
  const attached = finiteOrNull(input.attached);
  const staffable = finiteOrNull(input.staffable);
  const disconnected =
    finiteOrNull(input.disconnected) ??
    (attached != null && staffable != null ? Math.max(0, attached - staffable) : null);
  const sent = Math.max(0, input.sent);
  const paused = Math.max(0, input.pausedCampaigns ?? 0);
  const active = Math.max(0, input.activeCampaigns ?? 0);
  const cap = finiteOrNull(input.maxLeadsPerDay);
  const total = finiteOrNull(input.sendersTotal);
  const atCap = finiteOrNull(input.sendersAtCap);
  const dailyMax = finiteOrNull(input.senderDailyMax);
  const capacityLeft = finiteOrNull(input.capacityLeft);

  if (total != null && total > 0 && atCap != null && atCap / total + 1e-9 >= SENDER_CAP_SHARE) {
    const who = atCap >= total ? `all ${total}` : `${atCap} of ${total}`;
    const max = dailyMax != null && dailyMax > 0 ? ` (${fmt(dailyMax)}/day max)` : "";
    return { kind: "senders", text: `sender-capped: ${who} senders hit their daily limit${max}` };
  }

  if (remaining != null) {
    const short =
      capacityLeft != null
        ? remaining < capacityLeft
        : remaining <= 0 || remaining < LOW_LEAD_REMAINING || sent + remaining < alertMax;
    if (short) {
      return {
        kind: "leads",
        text:
          remaining <= 0
            ? "no leads left on ACTIVE lists"
            : capacityLeft != null
              ? `not enough leads: ${fmt(remaining)} new leads left vs ${fmt(capacityLeft)} sends of capacity left`
              : "too few leads on ACTIVE lists",
      };
    }
  }

  if (input.bounceHold) {
    return { kind: "bounce", text: "bounce hold: a list was auto-paused for high bounce" };
  }

  if (paused > 0 && (active <= 0 || paused >= active)) {
    return {
      kind: "paused",
      text: paused === 1 ? "paused campaigns" : `${paused} campaigns paused`,
    };
  }

  const inboxCount = attached ?? staffable;
  if (inboxCount != null && inboxCount <= 0) {
    return { kind: "inboxes", text: "no campaign inboxes linked" };
  }
  if ((disconnected ?? 0) > 0) {
    return {
      kind: "inboxes",
      text: `${disconnected} sender${disconnected === 1 ? "" : "s"} disconnected (SMTP/IMAP down)`,
    };
  }
  if (inboxCount != null && inboxCount < CANON_MIN_SENDERS) {
    return { kind: "inboxes", text: `only ~${inboxCount} campaign inboxes linked` };
  }

  if (cap != null && cap > 0 && (cap < alertMax || sent >= Math.floor(cap * 0.85))) {
    return { kind: "caps", text: "daily send cap hitting" };
  }

  if (input.outsideWindow) {
    return { kind: "schedule", text: "outside send window" };
  }

  return { kind: "pace", text: UNDER_REASON_FALLBACK };
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
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
