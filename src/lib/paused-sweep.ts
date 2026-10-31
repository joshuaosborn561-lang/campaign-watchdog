import { isNoiseCampaign } from "./names.js";

/**
 * Josh's standing rule (10/7, restated 10/29): every campaign that is PAUSED, including
 * Smartlead bounce auto-pauses, gets restarted. A STOPPED campaign is never restarted.
 * Held on purpose: the five Goliath campaigns.
 */
export const DEFAULT_PAUSED_SWEEP_HOLD_IDS = [3851730, 3851731, 3815446, 3815447, 3815448];

/** Never restart: Gabe's call campaigns, leftover shells and holdouts. */
export const DEFAULT_PAUSED_SWEEP_EXCLUDE_IDS = [
  3977481, 3977483, 3977484, 3977485, 3969268, 3739316, 4085158, 4085159, 4085160,
];

/** Vasco Warranty (retired client). */
export const DEFAULT_PAUSED_SWEEP_EXCLUDE_CLIENT_IDS = [548609];

export interface PausedSweepCandidate {
  id: number;
  name: string;
  status?: string;
  clientId: number | null;
  linkedMailboxes?: number | null;
  remainingLeads?: number | null;
}

export interface PausedSweepRules {
  holdIds: Iterable<number>;
  excludeIds: Iterable<number>;
  excludeClientIds: Iterable<number>;
}

export type PausedSweepSkip =
  | "stopped"
  | "not paused"
  | "noise"
  | "no client"
  | "held on purpose"
  | "excluded id"
  | "excluded client"
  | "no senders"
  | "no leads";

/**
 * Why this PAUSED campaign must stay paused. `null` means START it.
 * Status gate comes first: only the exact status PAUSED is ever startable.
 */
export function pausedSweepSkipReason(
  candidate: PausedSweepCandidate,
  rules: PausedSweepRules,
): PausedSweepSkip | null {
  const status = String(candidate.status ?? "").trim().toUpperCase();
  if (status === "STOPPED") return "stopped";
  if (status !== "PAUSED") return "not paused";
  if (isNoiseCampaign(candidate.name)) return "noise";
  if (candidate.clientId == null) return "no client";
  if (new Set(rules.holdIds).has(candidate.id)) return "held on purpose";
  if (new Set(rules.excludeIds).has(candidate.id)) return "excluded id";
  if (new Set(rules.excludeClientIds).has(candidate.clientId)) return "excluded client";
  if (candidate.linkedMailboxes != null && candidate.linkedMailboxes <= 0) return "no senders";
  if (candidate.remainingLeads != null && candidate.remainingLeads <= 0) return "no leads";
  return null;
}
