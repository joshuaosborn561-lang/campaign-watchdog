import type { CampaignSchedule } from "./schedule.js";
import { gapLimitedSendsPerInbox } from "./schedule.js";

export type SendingKind =
  | "ok_scheduled"
  | "ok_exhausted"
  | "ok_gap_limited"
  | "ok_on_pace"
  | "not_staffed"
  | "inboxes_down"
  | "under_sending";

export interface SendingDiagnosis {
  kind: SendingKind;
  shouldAlert: boolean;
  reason: string;
  receipts: string[];
  sent: number;
  remaining: number;
  attached: number;
  staffable: number;
  disconnected: number;
  inboxesThatSent: number;
  campaignCap: number | null;
  gapMinutes: number;
  perInboxGapCap: number;
  inboxCapacity: number;
  schedulable: number;
}

export interface InboxHealth {
  attached: number;
  staffable: number;
  disconnected: number;
  inboxesThatSent: number;
}

export function diagnoseSending(input: {
  sent: number;
  remaining: number | null;
  schedule: CampaignSchedule;
  inboxes: InboxHealth;
  messagePerDay: number;
}): SendingDiagnosis | null {
  if (input.remaining == null || !Number.isFinite(input.remaining)) return null;
  const remaining = Math.max(0, input.remaining);
  const perInboxGapCap = gapLimitedSendsPerInbox(input.schedule, input.messagePerDay);
  const inboxCapacity = input.inboxes.staffable * perInboxGapCap;
  const campaignCap = input.schedule.maxLeadsPerDay;
  const schedulable = minPositive([
    remaining,
    campaignCap,
    inboxCapacity > 0 ? inboxCapacity : null,
  ]);

  const receipts = [
    `Sent ${input.sent.toLocaleString()} today`,
    `${remaining.toLocaleString()} leads left in the campaign`,
    campaignCap != null
      ? `Smartlead daily cap ${campaignCap.toLocaleString()} new leads`
      : "No Smartlead daily lead cap on this campaign",
    `Window ${clock(input.schedule.startHour, input.schedule.startMinute)}–${clock(input.schedule.endHour, input.schedule.endMinute)} ${input.schedule.timeZone}`,
    `${input.schedule.gapMinutes} min gap between sends → ${perInboxGapCap} sends/inbox (${input.messagePerDay}/day cap)`,
    `${input.inboxes.staffable} staffable / ${input.inboxes.attached} attached` +
      (input.inboxes.disconnected
        ? ` (${input.inboxes.disconnected} SMTP/IMAP down)`
        : ""),
    input.inboxes.inboxesThatSent
      ? `${input.inboxes.inboxesThatSent} inbox${input.inboxes.inboxesThatSent === 1 ? "" : "es"} actually sent today`
      : "No inbox has a same-day sent count",
    `Schedulable today ${schedulable.toLocaleString()} (min of leads left, daily cap, staffed × gap capacity)`,
  ];

  if (remaining <= 0) {
    return done("ok_exhausted", "No leads left to send.", receipts, input, {
      remaining,
      campaignCap,
      perInboxGapCap,
      inboxCapacity,
      schedulable,
    });
  }

  if (input.inboxes.attached === 0 || input.inboxes.staffable === 0) {
    return problem(
      "not_staffed",
      "Not staffed — no connected inbox can send.",
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  if (matchesScheduledVolume(input.sent, remaining, campaignCap)) {
    return done(
      "ok_scheduled",
      campaignCap != null && input.sent >= campaignCap
        ? `That's all Smartlead scheduled today (daily cap ${campaignCap}).`
        : `That's all that was left to send today (${remaining} leads remaining, sent ${input.sent}).`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  if (inboxCapacity > 0 && input.sent >= Math.floor(inboxCapacity * 0.85)) {
    return done(
      "ok_gap_limited",
      `Hit the ${input.schedule.gapMinutes}-min gap ceiling on ${input.inboxes.staffable} staffable inbox${input.inboxes.staffable === 1 ? "" : "es"} (${inboxCapacity} possible today).`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  if (schedulable > 0 && input.sent >= Math.max(schedulable - 2, Math.floor(schedulable * 0.85))) {
    return done(
      "ok_on_pace",
      `Sent ${input.sent} of ${schedulable} that could go today.`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  if (
    input.inboxes.staffable <= 1 &&
    input.sent <= 2 &&
    remaining >= 10
  ) {
    return problem(
      "not_staffed",
      `Only ${input.inboxes.staffable} staffable inbox and ${input.sent} send${input.sent === 1 ? "" : "s"} with ${remaining.toLocaleString()} leads left.`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  if (
    input.inboxes.attached >= 5 &&
    input.inboxes.staffable <= Math.max(1, Math.floor(input.inboxes.attached * 0.3))
  ) {
    return problem(
      "inboxes_down",
      `${input.inboxes.disconnected} of ${input.inboxes.attached} attached inboxes are SMTP/IMAP down. Only ${input.inboxes.staffable} can send.`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  // A small send on a fat list is usually Smartlead's daily drip, not a miss.
  // Only call a stall when a staffed campaign sent almost nothing.
  if (input.inboxes.staffable >= 3 && remaining >= 10 && input.sent <= 2) {
    return problem(
      "under_sending",
      `Staffed with ${input.inboxes.staffable} inboxes and ${remaining.toLocaleString()} leads still in play, but only sent ${input.sent}.`,
      receipts,
      input,
      { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
    );
  }

  return done(
    "ok_on_pace",
    `Sent ${input.sent}; not a clear miss after schedule, staffing, and the ${input.schedule.gapMinutes}-min gap.`,
    receipts,
    input,
    { remaining, campaignCap, perInboxGapCap, inboxCapacity, schedulable },
  );
}

function matchesScheduledVolume(
  sent: number,
  remaining: number,
  campaignCap: number | null,
): boolean {
  if (campaignCap != null && sent >= campaignCap && campaignCap > 0) return true;
  if (remaining > 0 && remaining <= 40 && sent >= remaining) return true;
  if (remaining > 0 && remaining <= 40 && sent >= remaining - 1 && sent > 0) return true;
  return false;
}

function minPositive(values: Array<number | null>): number {
  const usable = values.filter((value): value is number => value != null && value > 0);
  if (!usable.length) return 0;
  return Math.min(...usable);
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function done(
  kind: SendingKind,
  reason: string,
  receipts: string[],
  input: { sent: number; inboxes: InboxHealth; schedule: CampaignSchedule },
  extra: {
    remaining: number;
    campaignCap: number | null;
    perInboxGapCap: number;
    inboxCapacity: number;
    schedulable: number;
  },
): SendingDiagnosis {
  return {
    kind,
    shouldAlert: false,
    reason,
    receipts,
    sent: input.sent,
    attached: input.inboxes.attached,
    staffable: input.inboxes.staffable,
    disconnected: input.inboxes.disconnected,
    inboxesThatSent: input.inboxes.inboxesThatSent,
    gapMinutes: input.schedule.gapMinutes,
    ...extra,
  };
}

function problem(
  kind: SendingKind,
  reason: string,
  receipts: string[],
  input: { sent: number; inboxes: InboxHealth; schedule: CampaignSchedule },
  extra: {
    remaining: number;
    campaignCap: number | null;
    perInboxGapCap: number;
    inboxCapacity: number;
    schedulable: number;
  },
): SendingDiagnosis {
  return { ...done(kind, reason, receipts, input, extra), shouldAlert: true };
}

export function shouldCheckSending(input: {
  hour: number;
  afterHour: number;
  weekend: boolean;
  sendOnWeekends?: boolean;
}): boolean {
  if (input.weekend && !input.sendOnWeekends) return false;
  return input.hour >= input.afterHour;
}
