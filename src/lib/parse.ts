export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function pickNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function pickString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const nested = row.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...row, ...(nested as Record<string, unknown>) };
  }
  return row;
}

export function asRecordArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  const root = unwrap(raw);
  if (!root) return [];
  for (const key of ["data", "email_accounts", "accounts", "result", "items"]) {
    const value = root[key];
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    }
  }
  return [];
}

export function textBlob(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}
