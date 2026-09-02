function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function csvNumbers(name: string, fallback: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? values : fallback;
}

function csvStrings(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

export interface HeyReachWorkspaceConfig {
  id: string;
  clientName: string;
  apiKey: string;
}

const HEYREACH_CLIENT_NAMES: Record<string, string> = {
  salesglider: "SalesGlider",
  techevo: "TechEvolution",
};

/** Workspace keys from Railway env. Never reads vault. Skips MASTER / org keys. */
export function heyreachWorkspacesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HeyReachWorkspaceConfig[] {
  const byId = new Map<string, HeyReachWorkspaceConfig>();

  const json = env.HEYREACH_WORKSPACES?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      for (const workspace of normalizeWorkspaceJson(parsed)) {
        if (isMasterWorkspace(workspace.id)) continue;
        byId.set(workspace.id, workspace);
      }
    } catch {
      throw new Error("HEYREACH_WORKSPACES must be JSON object or array");
    }
  }

  for (const [name, value] of Object.entries(env)) {
    const match = /^HEYREACH_(.+)_API_KEY$/.exec(name);
    if (!match || !value?.trim()) continue;
    const slug = match[1].toLowerCase().replace(/_/g, "");
    if (isMasterWorkspace(slug) || slug === "workspaces") continue;
    const id = match[1].toLowerCase().replace(/_/g, "-");
    byId.set(id, {
      id,
      clientName: HEYREACH_CLIENT_NAMES[slug] ?? titleCaseSlug(match[1]),
      apiKey: value.trim(),
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isMasterWorkspace(id: string): boolean {
  return /master/i.test(id);
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeWorkspaceJson(parsed: unknown): HeyReachWorkspaceConfig[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const apiKey = String(record.apiKey ?? record.api_key ?? "").trim();
      const rawId = String(record.id ?? record.clientName ?? record.name ?? "").trim();
      if (!apiKey || !rawId) return [];
      const id = rawId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const clientName =
        String(record.clientName ?? record.client_name ?? record.name ?? "").trim() ||
        HEYREACH_CLIENT_NAMES[id.replace(/-/g, "")] ||
        titleCaseSlug(rawId);
      return [{ id, clientName, apiKey }];
    });
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).flatMap(([name, value]) => {
      const apiKey = typeof value === "string" ? value.trim() : "";
      if (!apiKey || !name.trim()) return [];
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return [
        {
          id,
          clientName: HEYREACH_CLIENT_NAMES[id.replace(/-/g, "")] || name.trim(),
          apiKey,
        },
      ];
    });
  }
  return [];
}

export interface AppConfig {
  smartleadApiKey: string;
  slackBotToken: string;
  slackAccessToken: string;
  slackRefreshToken: string;
  slackClientId: string;
  slackClientSecret: string;
  slackChannelId: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  messagePerDay: number;
  mailboxMinTimeGapMins: number;
  completionThresholds: number[];
  sendShortfallAfterHour: number;
  sendShortfallTimezone: string;
  bounceAutoPauseThreshold: number;
  minBounceSample: number;
  cron: string;
  pulseCron: string;
  pulseHours: number[];
  pulseWeekdays: number[];
  watchStatuses: string[];
  alertExistingAutobounce: boolean;
  port: number;
  host: string;
  runToken: string;
  stateFilePath: string;
  heyreachWorkspaces: HeyReachWorkspaceConfig[];
  heyreachExcludeIds: number[];
  heyreachRunwayDays: number;
  heyreachPaceLookbackDays: number;
  heyreachWeekdays: number[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const previous = process.env;
  process.env = env;
  try {
    const slackChannelId = optional("SLACK_CHANNEL_ID", "C0BT978GSAC");
    const smartleadApiKey = required("SMARTLEAD_API_KEY");
    const slackBotToken = optional("SLACK_BOT_TOKEN");
    const slackAccessToken = optional("SLACK_ACCESS_TOKEN");
    if (!slackBotToken && !slackAccessToken) {
      throw new Error("Set SLACK_BOT_TOKEN or SLACK_ACCESS_TOKEN");
    }
    return {
      smartleadApiKey,
      slackBotToken,
      slackAccessToken,
      slackRefreshToken: optional("SLACK_REFRESH_TOKEN"),
      slackClientId: optional("SLACK_CLIENT_ID"),
      slackClientSecret: optional("SLACK_CLIENT_SECRET"),
      slackChannelId,
      supabaseUrl: optional("SUPABASE_URL"),
      supabaseServiceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY"),
      messagePerDay: optionalNumber("MESSAGE_PER_DAY", 30),
      mailboxMinTimeGapMins: optionalNumber("MAILBOX_MIN_TIME_GAP_MINS", 10),
      completionThresholds: csvNumbers("COMPLETION_THRESHOLDS", [50, 75, 90, 100]),
      sendShortfallAfterHour: optionalNumber("SEND_SHORTFALL_AFTER_HOUR", 17),
      sendShortfallTimezone: optional("SEND_SHORTFALL_TIMEZONE", "America/Chicago"),
      bounceAutoPauseThreshold: optionalNumber("BOUNCE_AUTO_PAUSE_THRESHOLD", 5),
      minBounceSample: optionalNumber("MIN_BOUNCE_SAMPLE", 20),
      cron: optional("CRON", "*/15 * * * *"),
      pulseCron: optional("PULSE_CRON", "5 8,10,12,14,16 * * 1-4"),
      pulseHours: csvNumbers("PULSE_HOURS", [8, 10, 12, 14, 16]),
      pulseWeekdays: csvNumbers("PULSE_WEEKDAYS", [1, 2, 3, 4]),
      watchStatuses: csvStrings("WATCH_STATUSES", ["ACTIVE", "PAUSED"]),
      alertExistingAutobounce: optionalBool("ALERT_EXISTING_AUTOBOUNCE", false),
      port: optionalNumber("PORT", 3000),
      host: optional("HOST", "0.0.0.0"),
      runToken: optional("RUN_TOKEN"),
      stateFilePath: optional("STATE_FILE_PATH", "/data/watchdog-state.json"),
      heyreachWorkspaces: heyreachWorkspacesFromEnv(env),
      heyreachExcludeIds: csvNumbers("HEYREACH_ALERT_EXCLUDE_IDS", [530529]),
      heyreachRunwayDays: optionalNumber("HEYREACH_RUNWAY_DAYS", 7),
      heyreachPaceLookbackDays: optionalNumber("HEYREACH_PACE_LOOKBACK_DAYS", 14),
      heyreachWeekdays: csvNumbers("HEYREACH_WEEKDAYS", [1, 2, 3, 4, 5]),
    };
  } finally {
    process.env = previous;
  }
}
