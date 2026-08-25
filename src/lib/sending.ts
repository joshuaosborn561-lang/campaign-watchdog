export interface SendingShortfall {
  inboxCount: number;
  expected: number;
  sent: number;
  shortBy: number;
  perInboxTarget: number;
}

export function sendingTarget(inboxCount: number, perInboxTarget: number): number {
  if (inboxCount <= 0 || perInboxTarget <= 0) return 0;
  return inboxCount * perInboxTarget;
}

export function sendingShortfall(input: {
  inboxCount: number;
  sent: number;
  perInboxTarget: number;
}): SendingShortfall | null {
  const expected = sendingTarget(input.inboxCount, input.perInboxTarget);
  if (expected <= 0) return null;
  if (input.sent >= expected) return null;
  return {
    inboxCount: input.inboxCount,
    expected,
    sent: input.sent,
    shortBy: expected - input.sent,
    perInboxTarget: input.perInboxTarget,
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
