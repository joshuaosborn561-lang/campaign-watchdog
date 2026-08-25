export interface SendingShortfall {
  inboxCount: number;
  expected: number;
  sent: number;
  shortBy: number;
  perInboxTarget: number;
  remaining: number;
  inboxCapacity: number;
  cappedByLeads: boolean;
}

export function sendingTarget(
  inboxCount: number,
  perInboxTarget: number,
  remaining?: number,
): number {
  if (inboxCount <= 0 || perInboxTarget <= 0) return 0;
  const inboxCapacity = inboxCount * perInboxTarget;
  if (remaining == null || !Number.isFinite(remaining)) return inboxCapacity;
  if (remaining <= 0) return 0;
  return Math.min(inboxCapacity, remaining);
}

export function sendingShortfall(input: {
  inboxCount: number;
  sent: number;
  perInboxTarget: number;
  remaining?: number;
}): SendingShortfall | null {
  if (input.remaining == null || !Number.isFinite(input.remaining)) return null;
  if (input.remaining <= 0) return null;
  const inboxCapacity = sendingTarget(input.inboxCount, input.perInboxTarget);
  const expected = sendingTarget(input.inboxCount, input.perInboxTarget, input.remaining);
  if (expected <= 0) return null;
  if (input.sent >= expected) return null;
  return {
    inboxCount: input.inboxCount,
    expected,
    sent: input.sent,
    shortBy: expected - input.sent,
    perInboxTarget: input.perInboxTarget,
    remaining: input.remaining,
    inboxCapacity,
    cappedByLeads: input.remaining < inboxCapacity,
  };
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
