import { asNumber, pickString } from "./parse.js";

export interface StaffableAccount {
  id: number;
  email?: string;
  smtpOk: boolean;
  imapOk: boolean;
  dailySent: number;
  messagePerDay?: number;
  gapMinutes?: number;
}

export function classifyInboxes(accounts: StaffableAccount[]): {
  attached: number;
  staffable: number;
  disconnected: number;
  inboxesThatSent: number;
} {
  const attached = accounts.filter((account) => account.id > 0);
  const staffable = attached.filter((account) => account.smtpOk && account.imapOk);
  return {
    attached: attached.length,
    staffable: staffable.length,
    disconnected: attached.length - staffable.length,
    inboxesThatSent: attached.filter((account) => account.dailySent > 0).length,
  };
}

export function accountFromSmartlead(row: Record<string, unknown>): StaffableAccount {
  const smtp = row.is_smtp_success;
  const imap = row.is_imap_success;
  return {
    id: asNumber(row.id) ?? 0,
    email:
      pickString(row, ["from_email", "email", "username", "fromEmail"]) ?? undefined,
    smtpOk: smtp === false || smtp === "false" ? false : true,
    imapOk: imap === false || imap === "false" ? false : true,
    dailySent: asNumber(row.daily_sent_count ?? row.dailySentCount) ?? 0,
    messagePerDay: asNumber(row.message_per_day ?? row.max_email_per_day),
    gapMinutes: asNumber(row.minTimeToWaitInMins ?? row.time_to_wait_in_mins),
  };
}
