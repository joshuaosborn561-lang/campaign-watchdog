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
  watchStatuses: string[];
  alertExistingAutobounce: boolean;
  port: number;
  host: string;
  runToken: string;
  stateFilePath: string;
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
      sendShortfallTimezone: optional("SEND_SHORTFALL_TIMEZONE", "America/New_York"),
      bounceAutoPauseThreshold: optionalNumber("BOUNCE_AUTO_PAUSE_THRESHOLD", 5),
      minBounceSample: optionalNumber("MIN_BOUNCE_SAMPLE", 20),
      cron: optional("CRON", "*/15 * * * *"),
      watchStatuses: csvStrings("WATCH_STATUSES", ["ACTIVE", "PAUSED"]),
      alertExistingAutobounce: optionalBool("ALERT_EXISTING_AUTOBOUNCE", false),
      port: optionalNumber("PORT", 3000),
      host: optional("HOST", "0.0.0.0"),
      runToken: optional("RUN_TOKEN"),
      stateFilePath: optional("STATE_FILE_PATH", "/data/watchdog-state.json"),
    };
  } finally {
    process.env = previous;
  }
}
