import { asRecordArray, asNumber, pickString, unwrap } from "./parse.js";
import { isNoiseCampaign } from "./names.js";
import { ymdInZone } from "./time.js";

/** Leftover / holdout Smartlead IDs — never auto-START these bounce holds. */
export const DEFAULT_BOUNCE_RESUME_EXCLUDE_IDS = [
  3977481, 3977483, 3977484, 3977485, 3969268, 3739316, 4085158, 4085159, 4085160, 3921647,
  3921651, 4041409,
];

/** Goliath Cybersecurity — hold bounce-resume through this Chicago date (inclusive). */
export const GOLIATH_BOUNCE_RESUME_CLIENT_ID = 548611;
export const GOLIATH_BOUNCE_RESUME_HOLD_THROUGH = "2026-10-15";

export interface BounceResumeCandidate {
  id: number;
  name: string;
  status?: string;
  clientId: number | null;
  pausedReason?: string | null;
  lastAutobounceAlertAt?: string;
  fromActivityLog?: boolean;
  linkedMailboxes?: number | null;
  remainingLeads?: number | null;
}

export interface BounceResumeRules {
  enabled: boolean;
  excludeIds: Iterable<number>;
  now: Date;
  timeZone: string;
  goliathClientId?: number;
  goliathHoldThrough?: string;
}

const BOUNCE_PROTECTION =
  /bounce\s*protection|bounce[-_\s]?auto[-_\s]?pause|high\s*bounce|auto[-_\s]?bounce/i;

export function isBounceProtectionReason(reason?: string | null): boolean {
  return Boolean(reason && BOUNCE_PROTECTION.test(reason));
}

/** `paused_reason` on the campaign row or nested `campaign_activity_logs`. */
export function pausedReasonFrom(raw: unknown): string | undefined {
  const root = unwrap(raw);
  if (!root) return undefined;
  const direct = pickString(root, [
    "paused_reason",
    "pause_reason",
    "auto_pause_reason",
    "status_reason",
  ]);
  if (direct) return direct;
  const logs = asRecordArray(root.campaign_activity_logs ?? root.campaignActivityLogs);
  for (const log of [...logs].reverse()) {
    const reason = pickString(log, ["paused_reason", "pause_reason", "reason"]);
    if (reason) return reason;
  }
  return undefined;
}

export function campaignIdFromActivityLog(row: Record<string, unknown>): number | null {
  return (
    asNumber(row.campaign_id) ??
    asNumber(row.smartlead_campaign_id) ??
    asNumber(row.campaignId) ??
    null
  );
}

export function isBounceHold(candidate: BounceResumeCandidate): boolean {
  return Boolean(
    candidate.fromActivityLog ||
      candidate.lastAutobounceAlertAt ||
      isBounceProtectionReason(candidate.pausedReason),
  );
}

/**
 * Why this bounce hold should stay paused. `null` means START it.
 * Mailbox / remaining checks apply only after those fields are known.
 */
export function bounceResumeSkipReason(
  candidate: BounceResumeCandidate,
  rules: BounceResumeRules,
): string | null {
  if (!rules.enabled) return "disabled";
  if (String(candidate.status ?? "PAUSED").toUpperCase() !== "PAUSED") return "not paused";
  if (!isBounceHold(candidate)) return "not a bounce hold";
  if (isNoiseCampaign(candidate.name)) return "noise";
  if (new Set(rules.excludeIds).has(candidate.id)) return "excluded id";
  if (candidate.clientId == null) return "no client";
  const goliathId = rules.goliathClientId ?? GOLIATH_BOUNCE_RESUME_CLIENT_ID;
  const holdThrough = rules.goliathHoldThrough ?? GOLIATH_BOUNCE_RESUME_HOLD_THROUGH;
  if (
    candidate.clientId === goliathId &&
    ymdInZone(rules.now, rules.timeZone) <= holdThrough
  ) {
    return "goliath hold";
  }
  if (candidate.linkedMailboxes != null && candidate.linkedMailboxes <= 0) {
    return "no mailboxes";
  }
  if (candidate.remainingLeads != null && candidate.remainingLeads <= 0) {
    return "no leads";
  }
  return null;
}

export function selectBounceHoldsToResume<T extends BounceResumeCandidate>(
  candidates: T[],
  rules: BounceResumeRules,
): T[] {
  return candidates.filter((candidate) => bounceResumeSkipReason(candidate, rules) == null);
}
