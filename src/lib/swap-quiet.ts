import { minutesInZone, weekdayInZone } from "./time.js";

/**
 * Whether Watchdog should stay off Smartlead while the deliverability
 * wizard runs its weekly POD swap.
 *
 * The wizard PR that publishes "swap in progress" is not in this repo.
 * `source=auto` reads whatever is configured (HTTP, then Supabase) and
 * treats a successful answer as the truth. A failed or missing signal
 * falls back to the Monday-morning window.
 */
export type SwapQuietSource = "auto" | "http" | "supabase" | "window" | "off";

export interface SwapQuietSettings {
  source: SwapQuietSource;
  signalUrl: string;
  signalToken: string;
  signalTable: string;
  signalSchema: string;
  /** When set, the Supabase read is `id=eq.<rowId>` instead of "latest row". */
  signalRowId: string;
  signalTimeoutMs: number;
  /** Ignore an open started_at older than this. A stuck flag must not silence the day. */
  signalMaxAgeMinutes: number;
  weekdays: number[];
  /** Minutes past midnight in `timeZone`, inclusive. */
  startMinutes: number;
  /** Minutes past midnight in `timeZone`, exclusive. */
  endMinutes: number;
  timeZone: string;
}

export interface SwapSignalRead {
  enabled(): boolean;
  fetchSwapSignal(table: string, schema: string, rowId: string): Promise<unknown>;
}

export interface SwapQuietDecision {
  quiet: boolean;
  reason: string;
  source: "http" | "supabase" | "window" | "off" | "none";
  startedAt: string | null;
  finishedAt: string | null;
}

export interface InterpretedSwapSignal {
  known: boolean;
  inProgress: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

const RUNNING_STATUS = new Set([
  "in_progress",
  "in-progress",
  "inprogress",
  "running",
  "active",
  "swapping",
  "started",
  "open",
]);

const IDLE_STATUS = new Set([
  "finished",
  "complete",
  "completed",
  "idle",
  "done",
  "cancelled",
  "canceled",
  "inactive",
  "closed",
]);

const TRUE_STRINGS = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_STRINGS = new Set(["0", "false", "no", "n", "off"]);

export function parseSwapQuietSource(raw: string | undefined): SwapQuietSource {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (
    value === "auto" ||
    value === "http" ||
    value === "supabase" ||
    value === "window" ||
    value === "off"
  ) {
    return value;
  }
  throw new Error("SWAP_QUIET_SOURCE must be auto, http, supabase, window, or off");
}

/** `06:00`, `6:00`, or `6` → minutes past midnight. */
export function parseClockMinutes(raw: string | undefined, name: string, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`${name} must be HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) throw new Error(`${name} must be HH:MM`);
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) throw new Error(`${name} must be HH:MM`);
  if (hour === 24 && minute !== 0) throw new Error(`${name} must be HH:MM`);
  return hour * 60 + minute;
}

export function inSwapQuietWindow(now: Date, settings: SwapQuietSettings): boolean {
  if (!settings.weekdays.includes(weekdayInZone(now, settings.timeZone))) return false;
  const minutes = minutesInZone(now, settings.timeZone);
  return minutes >= settings.startMinutes && minutes < settings.endMinutes;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickField(row: Record<string, unknown>, names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}

function asTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || FALSE_STRINGS.has(trimmed.toLowerCase())) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (TRUE_STRINGS.has(text)) return true;
  if (FALSE_STRINGS.has(text)) return false;
  return null;
}

function unwrapPayload(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) return newestRow(payload);
  const row = asRecord(payload);
  if (!row) return null;
  for (const key of ["data", "swap", "signal", "result", "row"]) {
    const nested = row[key] ?? row[key.toLowerCase()];
    if (nested == null) continue;
    if (Array.isArray(nested)) return newestRow(nested);
    const inner = asRecord(nested);
    if (inner) return inner;
  }
  return row;
}

function newestRow(rows: unknown[]): Record<string, unknown> | null {
  const records = rows.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
  if (!records.length) return null;
  return records.reduce((best, row) => {
    const bestAt = asTimestamp(pickField(best, ["started_at", "startedAt", "created_at", "createdAt"]));
    const rowAt = asTimestamp(pickField(row, ["started_at", "startedAt", "created_at", "createdAt"]));
    if (rowAt && (!bestAt || rowAt > bestAt)) return row;
    return best;
  });
}

/**
 * Read a wizard payload without assuming one field name.
 * `known: false` means "this is not a swap signal" (fall back to the window).
 * A past `finished_at` means the swap is over, even inside the Monday window.
 */
export function interpretSwapSignal(
  payload: unknown,
  now: Date,
  maxAgeMs: number,
): InterpretedSwapSignal {
  const row = unwrapPayload(payload);
  if (!row) return { known: false, inProgress: false, startedAt: null, finishedAt: null };

  const startedAt = asTimestamp(pickField(row, ["started_at", "startedAt", "start", "started"]));
  const finishedAt = asTimestamp(
    pickField(row, ["finished_at", "finishedAt", "ended_at", "endedAt", "completed_at", "completedAt"]),
  );
  const flag = asBool(
    pickField(row, [
      "in_progress",
      "inProgress",
      "swap_in_progress",
      "swapInProgress",
      "active",
      "quiet",
      "running",
    ]),
  );
  const statusRaw = pickField(row, ["status", "state", "phase"]);
  const status = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";

  const recognizable = flag != null || status.length > 0 || startedAt != null || finishedAt != null;
  if (!recognizable) return { known: false, inProgress: false, startedAt, finishedAt };

  if (finishedAt) {
    const finishedMs = Date.parse(finishedAt);
    if (Number.isFinite(finishedMs) && finishedMs <= now.getTime()) {
      return { known: true, inProgress: false, startedAt, finishedAt };
    }
  }

  if (flag != null) {
    return { known: true, inProgress: flag, startedAt, finishedAt };
  }

  if (status) {
    if (RUNNING_STATUS.has(status)) return { known: true, inProgress: true, startedAt, finishedAt };
    if (IDLE_STATUS.has(status)) return { known: true, inProgress: false, startedAt, finishedAt };
  }

  if (startedAt && !finishedAt) {
    const age = now.getTime() - Date.parse(startedAt);
    if (Number.isFinite(age) && age > maxAgeMs) {
      return { known: false, inProgress: false, startedAt, finishedAt };
    }
    return { known: true, inProgress: true, startedAt, finishedAt };
  }

  return { known: false, inProgress: false, startedAt, finishedAt };
}

export function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function windowDecision(now: Date, settings: SwapQuietSettings): SwapQuietDecision {
  const quiet = inSwapQuietWindow(now, settings);
  const span = `${formatClock(settings.startMinutes)}-${formatClock(settings.endMinutes)} ${settings.timeZone}`;
  const days = settings.weekdays.join(",");
  return {
    quiet,
    reason: quiet
      ? `Monday swap window ${span} (weekdays ${days})`
      : `outside swap window ${span}`,
    source: quiet ? "window" : "none",
    startedAt: null,
    finishedAt: null,
  };
}

export class SwapQuietGate {
  private cached: { at: number; forTime: number; decision: SwapQuietDecision } | null = null;
  private warned = false;

  constructor(
    private readonly settings: SwapQuietSettings,
    private readonly deps: {
      supabase?: SwapSignalRead | null;
      fetch?: typeof fetch;
      cacheMs?: number;
    } = {},
  ) {}

  async current(now = new Date()): Promise<SwapQuietDecision> {
    const cacheMs = this.deps.cacheMs ?? 15_000;
    const wall = Date.now();
    if (
      this.cached &&
      wall - this.cached.at < cacheMs &&
      Math.abs(now.getTime() - this.cached.forTime) < cacheMs
    ) {
      return this.cached.decision;
    }
    const decision = await this.read(now);
    this.cached = { at: wall, forTime: now.getTime(), decision };
    return decision;
  }

  private async read(now: Date): Promise<SwapQuietDecision> {
    const source = this.settings.source;
    if (source === "off") {
      return {
        quiet: false,
        reason: "swap quiet disabled",
        source: "off",
        startedAt: null,
        finishedAt: null,
      };
    }

    const wantHttp = source === "http" || (source === "auto" && this.settings.signalUrl.length > 0);
    const wantSupabase =
      source === "supabase" ||
      (source === "auto" && !this.settings.signalUrl && this.settings.signalTable.length > 0);

    if (wantHttp) {
      const signal = await this.readHttp(now);
      const decided = this.decideFromSignal(signal, "http");
      if (decided) return decided;
    } else if (wantSupabase) {
      const signal = await this.readSupabase(now);
      const decided = this.decideFromSignal(signal, "supabase");
      if (decided) return decided;
    }

    if (source === "http" && !this.settings.signalUrl) this.warnOnce("SWAP_SIGNAL_URL is empty");
    if (source === "supabase" && !this.settings.signalTable) this.warnOnce("SWAP_SIGNAL_TABLE is empty");
    return windowDecision(now, this.settings);
  }

  private decideFromSignal(
    signal: InterpretedSwapSignal | null,
    source: "http" | "supabase",
  ): SwapQuietDecision | null {
    if (!signal?.known) return null;
    if (signal.inProgress) {
      return {
        quiet: true,
        reason: `swap in progress via ${source}`,
        source,
        startedAt: signal.startedAt,
        finishedAt: signal.finishedAt,
      };
    }
    return {
      quiet: false,
      reason: `swap finished via ${source}`,
      source,
      startedAt: signal.startedAt,
      finishedAt: signal.finishedAt,
    };
  }

  private async readHttp(now: Date): Promise<InterpretedSwapSignal | null> {
    const url = this.settings.signalUrl;
    if (!url) return null;
    const fetchImpl = this.deps.fetch ?? fetch;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(this.settings.signalToken ? { Authorization: `Bearer ${this.settings.signalToken}` } : {}),
        },
        signal: AbortSignal.timeout(this.settings.signalTimeoutMs),
      });
      if (!response.ok) {
        this.warnOnce(`swap signal HTTP ${response.status}`);
        return null;
      }
      const payload = (await response.json()) as unknown;
      return interpretSwapSignal(payload, now, this.settings.signalMaxAgeMinutes * 60_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnOnce(`swap signal HTTP failed: ${message}`);
      return null;
    }
  }

  private async readSupabase(now: Date): Promise<InterpretedSwapSignal | null> {
    const table = this.settings.signalTable;
    const supabase = this.deps.supabase;
    if (!table || !supabase?.enabled()) {
      if (table && supabase && !supabase.enabled()) {
        this.warnOnce("swap signal table set but Supabase is not configured");
      }
      return null;
    }
    try {
      const payload = await supabase.fetchSwapSignal(
        table,
        this.settings.signalSchema || "public",
        this.settings.signalRowId,
      );
      return interpretSwapSignal(payload, now, this.settings.signalMaxAgeMinutes * 60_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnOnce(`swap signal supabase failed: ${message}`);
      return null;
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[watchdog] ${message}; using the swap window`);
  }
}
