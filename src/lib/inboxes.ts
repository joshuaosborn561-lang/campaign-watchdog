import { asNumber, asRecordArray, pickNumber, pickString, unwrap } from "./parse.js";

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

/** Linked inbox count from campaign detail/settings when the accounts API was skipped. */
export function parseLinkedInboxCount(raw: unknown): number | null {
  const root = unwrap(raw);
  if (!root) return null;
  for (const key of ["email_account_ids", "emailAccountIds", "account_ids"]) {
    const value = root[key];
    if (Array.isArray(value) && value.length) return value.length;
  }
  const accounts = asRecordArray(
    root.email_accounts ?? root.emailAccounts ?? root.accounts,
  );
  const linked = accounts.filter((row) => (asNumber(row.id) ?? 0) > 0).length;
  if (linked > 0) return linked;
  return (
    pickNumber(root, [
      "email_account_count",
      "emailAccountCount",
      "total_email_accounts",
      "account_count",
    ]) ?? null
  );
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
