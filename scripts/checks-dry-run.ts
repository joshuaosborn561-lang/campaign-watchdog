/**
 * Read-only dry run of the three checks against live data. Never POSTs to Slack, never
 * writes Smartlead status, never writes check state (state goes to a throwaway temp file).
 *
 *   railway run -- npx tsx scripts/checks-dry-run.ts [sweep|leads|drought|all]
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { SlackClient } from "../src/clients/slack.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { SupabaseStore } from "../src/clients/supabase.js";
import { ChecksService } from "../src/services/checks.js";
import { ChecksStore } from "../src/state/checks-store.js";

const which = (process.argv[2] ?? "all").toLowerCase();
const config = loadConfig();
const smartlead = new SmartleadClient(config.smartleadApiKey);
const supabase = new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey);
// A Slack client that cannot post: the dry run must never reach Slack.
const slack = new SlackClient({ channelId: config.slackChannelId });
const store = new ChecksStore(path.join(tmpdir(), `checks-dry-run-${Date.now()}.json`));
const checks = new ChecksService(config, smartlead, slack, supabase, store);
const opts = { forceDryRun: true, ignoreSchedule: true } as const;

const out: Record<string, unknown> = {};
if (which === "all" || which === "sweep") out.pausedSweep = await checks.runPausedSweep(opts);
if (which === "all" || which === "drought") out.meetingDrought = await checks.runMeetingDrought(opts);
if (which === "all" || which === "leads") out.leads = await checks.runLeadsCheck(opts);
console.log(JSON.stringify(out, null, 1));
