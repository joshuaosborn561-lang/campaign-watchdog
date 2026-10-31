/** `off` = skip. `dry-run` = read-only, report to logs only. `live` = act / post. */
export type CheckMode = "off" | "dry-run" | "live";

/** Anything unrecognised falls back to the safe default (dry-run). */
export function parseCheckMode(raw: string | undefined, fallback: CheckMode): CheckMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["off", "0", "false", "no", "disabled"].includes(value)) return "off";
  if (["live", "on", "1", "true", "yes"].includes(value)) return "live";
  if (["dry-run", "dry_run", "dryrun", "dry"].includes(value)) return "dry-run";
  return "dry-run";
}
