import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import {
  sleep,
  type SmartleadClient,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import type { CampaignNameRow, SupabaseStore } from "../clients/supabase.js";
import { resolveClient } from "../lib/clients.js";
import { parseLinkedInboxCount } from "../lib/inboxes.js";
import { parseCampaignLeadStats } from "../lib/completion.js";
import {
  classifyLane,
  daysLeftOf,
  decideDoubleSigAlerts,
  decideLeadAlerts,
  formatLeadsAlert,
  leadsSkipReason,
  weekdayWindow,
  type DoubleSigResult,
  type LaneKind,
  type LeadLane,
} from "../lib/leads-check.js";
import {
  computeDrought,
  decideDroughtAlerts,
  formatDroughtAlert,
  isTestBooking,
  type DroughtClient,
} from "../lib/meeting-drought.js";
import { isNoiseCampaign } from "../lib/names.js";
import { pausedSweepSkipReason, type PausedSweepSkip } from "../lib/paused-sweep.js";
import { asRecordArray, unwrap } from "../lib/parse.js";
import { analyzeSignature } from "../lib/signature.js";
import { hourInZone, isWeekendInZone, ymdInZone } from "../lib/time.js";
import type { ChecksStore } from "../state/checks-store.js";

export interface CheckRunOptions {
  now?: Date;
  /** Force read-only, log-only behaviour regardless of the configured mode. */
  forceDryRun?: boolean;
  /** Run outside the weekday 6am–8pm CT window (manual / dry-run use). */
  ignoreSchedule?: boolean;
}

type Directories = {
  campaigns: SmartleadCampaign[];
  clientsById: Map<number, SmartleadClientRecord>;
  supabaseCampaigns: Map<number, CampaignNameRow>;
  registry: Map<number, string>;
};

export interface PausedSweepReport {
  check: "paused-sweep";
  mode: string;
  ran: boolean;
  reason?: string;
  pausedTotal: number;
  clientPaused: number;
  noClientPaused: number;
  skipped: Array<{ id: number; name: string; client: string; reason: PausedSweepSkip }>;
  wouldStart: Array<{ id: number; name: string; client: string; senders: number; leadsLeft: number }>;
  started: Array<{ id: number; name: string; client: string; restartNumber: number; statusAfter: string }>;
  errors: string[];
  slackPosted: boolean;
}

export interface LeadsCheckReport {
  check: "leads-and-signatures";
  mode: string;
  ran: boolean;
  reason?: string;
  window?: { start: string; end: string; weekdays: number };
  activeClientCampaigns: number;
  lanesChecked: number;
  flagged: Array<LeadLane & { kind: LaneKind }>;
  alertedLanes: number;
  signatureCampaignsSampled: number;
  doubleSignatures: DoubleSigResult[];
  newDoubleSignatures: number;
  errors: string[];
  slackPosted: boolean;
  slackText: string | null;
  handoffFile?: string;
}

export interface DroughtReport {
  check: "meeting-drought";
  mode: string;
  ran: boolean;
  reason?: string;
  clientsChecked: number;
  bookingsRead: number;
  clients: Array<{
    client: string;
    meetingsInWindow: number;
    lastBookingAt: string | null;
    daysSinceLast: number | null;
    flagged: boolean;
  }>;
  uncovered: string[];
  alerted: string[];
  errors: string[];
  slackPosted: boolean;
  slackText: string | null;
}

/**
 * Deterministic checks moved out of Campaign Watchdog's bot routines. Each check reads
 * Smartlead / Supabase only. The one write is the paused-campaign sweep: Smartlead START
 * on a campaign that is PAUSED. It never PAUSEs or STOPs anything (the Smartlead client
 * refuses those) and never touches a STOPPED campaign. Slack posts exceptions only, to the
 * same channel the rest of Watchdog uses.
 */
export class ChecksService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly supabase: SupabaseStore,
    private readonly store: ChecksStore,
  ) {}

  private resolveMode(configured: string, opts: CheckRunOptions): "off" | "dry-run" | "live" {
    if (opts.forceDryRun) return "dry-run";
    return configured as "off" | "dry-run" | "live";
  }

  /** Live runs stay inside Mon–Fri 6am–8pm CT (quiet hours). Dry-runs are read-only so anywhere. */
  private outsideLiveWindow(now: Date, opts: CheckRunOptions): boolean {
    if (opts.ignoreSchedule) return false;
    const tz = this.config.sendShortfallTimezone;
    if (isWeekendInZone(now, tz)) return true;
    const hour = hourInZone(now, tz);
    return hour < 6 || hour >= 20;
  }

  private async loadDirectories(): Promise<Directories> {
    const [campaigns, clients, supabaseCampaigns, registry] = await Promise.all([
      this.smartlead.listCampaigns(),
      this.smartlead.listClients().catch(() => [] as SmartleadClientRecord[]),
      this.supabase.enabled()
        ? this.supabase.fetchCampaignNames().catch(() => new Map<number, CampaignNameRow>())
        : Promise.resolve(new Map<number, CampaignNameRow>()),
      this.supabase.enabled()
        ? this.supabase.fetchClientRegistry().catch(() => new Map<number, string>())
        : Promise.resolve(new Map<number, string>()),
    ]);
    return {
      campaigns,
      clientsById: new Map(clients.map((client) => [client.id, client])),
      supabaseCampaigns,
      registry,
    };
  }

  private clientOf(campaign: SmartleadCampaign, dirs: Directories) {
    return resolveClient(campaign, dirs.clientsById, dirs.supabaseCampaigns, dirs.registry);
  }

  private stamp(now: Date): string {
    const tz = this.config.sendShortfallTimezone;
    const hh = String(hourInZone(now, tz)).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    return `${ymdInZone(now, tz)}T${hh}${mm}`;
  }

  private header(label: string, now: Date): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.sendShortfallTimezone,
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const when = `${get("weekday")} ${get("month")}/${get("day")} ${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase()}`;
    return `${label} — ${when}`;
  }

  // ---------------------------------------------------------------- (a) paused sweep

  async runPausedSweep(opts: CheckRunOptions = {}): Promise<PausedSweepReport> {
    const now = opts.now ?? new Date();
    const mode = this.resolveMode(this.config.pausedSweepMode, opts);
    const report: PausedSweepReport = {
      check: "paused-sweep",
      mode,
      ran: false,
      pausedTotal: 0,
      clientPaused: 0,
      noClientPaused: 0,
      skipped: [],
      wouldStart: [],
      started: [],
      errors: [],
      slackPosted: false,
    };
    if (mode === "off") return { ...report, reason: "mode off" };
    if (mode === "live" && this.outsideLiveWindow(now, opts)) {
      return { ...report, reason: "outside weekday 6am-8pm CT" };
    }
    report.ran = true;

    const dirs = await this.loadDirectories();
    const rules = {
      holdIds: this.config.pausedSweepHoldIds,
      excludeIds: this.config.pausedSweepExcludeIds,
      excludeClientIds: this.config.pausedSweepExcludeClientIds,
    };
    const paused = dirs.campaigns.filter(
      (campaign) => String(campaign.status ?? "").trim().toUpperCase() === "PAUSED",
    );
    report.pausedTotal = paused.length;

    const startable: Array<{ campaign: SmartleadCampaign; client: string; senders: number; leadsLeft: number }> = [];
    for (const campaign of paused) {
      const client = this.clientOf(campaign, dirs);
      if (client.clientId == null) {
        report.noClientPaused += 1;
        continue;
      }
      report.clientPaused += 1;
      const base = {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        clientId: client.clientId,
      };
      const early = pausedSweepSkipReason(base, rules);
      if (early) {
        report.skipped.push({ id: campaign.id, name: campaign.name, client: client.clientName, reason: early });
        continue;
      }
      try {
        const [accounts, analytics] = await Promise.all([
          retrying(() => this.smartlead.getCampaignEmailAccounts(campaign.id)).catch(() => null),
          retrying(() => this.smartlead.getCampaignAnalytics(campaign.id)).catch(() => null),
        ]);
        if (!accounts) {
          // Can't prove it has senders: leave it paused and say so in the report.
          report.errors.push(`#${campaign.id} email-accounts fetch failed, left paused`);
          continue;
        }
        const senders =
          accounts.filter((account) => account.id > 0).length ||
          parseLinkedInboxCount(campaign) ||
          0;
        const stats = parseCampaignLeadStats(analytics);
        const leadsLeft = stats?.remaining;
        const full = pausedSweepSkipReason(
          { ...base, linkedMailboxes: senders, remainingLeads: leadsLeft ?? null },
          rules,
        );
        if (full) {
          report.skipped.push({ id: campaign.id, name: campaign.name, client: client.clientName, reason: full });
        } else {
          startable.push({ campaign, client: client.clientName, senders, leadsLeft: leadsLeft ?? -1 });
        }
      } catch (error) {
        report.errors.push(`#${campaign.id} inspect: ${errMsg(error)}`);
      }
      await sleep(150);
    }

    for (const item of startable) {
      const { campaign } = item;
      if (mode !== "live") {
        report.wouldStart.push({
          id: campaign.id,
          name: campaign.name,
          client: item.client,
          senders: item.senders,
          leadsLeft: item.leadsLeft,
        });
        continue;
      }
      try {
        // Re-read the live status right before the write: only an exact PAUSED may START.
        const fresh = unwrap(await this.smartlead.getCampaign(campaign.id));
        const freshStatus = String(fresh?.status ?? "").trim().toUpperCase();
        if (freshStatus !== "PAUSED") {
          report.skipped.push({
            id: campaign.id,
            name: campaign.name,
            client: item.client,
            reason: freshStatus === "STOPPED" ? "stopped" : "not paused",
          });
          continue;
        }
        await this.smartlead.updateCampaignStatus(campaign.id, "START");
        await sleep(1500);
        const after = unwrap(await this.smartlead.getCampaign(campaign.id));
        const key = String(campaign.id);
        const n = (this.store.state.sweep.restartCounts[key] ?? 0) + 1;
        this.store.state.sweep.restartCounts[key] = n;
        report.started.push({
          id: campaign.id,
          name: campaign.name,
          client: item.client,
          restartNumber: n,
          statusAfter: String(after?.status ?? "?"),
        });
      } catch (error) {
        report.errors.push(`#${campaign.id} start: ${errMsg(error)}`);
      }
      await sleep(300);
    }

    // Unstartable client campaigns (no senders / no leads): say so once per campaign.
    const unstartable = report.skipped.filter(
      (row) => row.reason === "no senders" || row.reason === "no leads",
    );
    const newUnstartable =
      mode === "live"
        ? unstartable.filter((row) => !this.store.state.sweep.unstartableNotified[String(row.id)])
        : [];

    if (mode === "live") {
      const lines: string[] = [];
      if (report.started.length) {
        lines.push(`*${this.header("Restarted paused campaigns", now)}*`);
        for (const row of report.started) {
          const again = row.restartNumber > 1 ? ` (restart #${row.restartNumber})` : "";
          lines.push(`• *${row.client}* — ${row.name} \`#${row.id}\` is ${row.statusAfter}${again}`);
        }
      }
      if (newUnstartable.length) {
        lines.push(
          `${lines.length ? "\n" : ""}*Paused and can't start:*`,
          ...newUnstartable.map(
            (row) => `• *${row.client}* — ${row.name} \`#${row.id}\` (${row.reason})`,
          ),
        );
      }
      if (report.errors.length) {
        lines.push(`${lines.length ? "\n" : ""}_${report.errors.length} restart error(s), see logs._`);
      }
      if (lines.length) {
        await this.slack.post(lines.join("\n"));
        report.slackPosted = true;
        for (const row of newUnstartable) {
          this.store.state.sweep.unstartableNotified[String(row.id)] = now.toISOString();
        }
      }
      await this.store.save();
    }
    return report;
  }

  // ---------------------------------------------------- (b) leads + double signatures

  async runLeadsCheck(opts: CheckRunOptions = {}): Promise<LeadsCheckReport> {
    const now = opts.now ?? new Date();
    const mode = this.resolveMode(this.config.leadsCheckMode, opts);
    const tz = this.config.sendShortfallTimezone;
    const report: LeadsCheckReport = {
      check: "leads-and-signatures",
      mode,
      ran: false,
      activeClientCampaigns: 0,
      lanesChecked: 0,
      flagged: [],
      alertedLanes: 0,
      signatureCampaignsSampled: 0,
      doubleSignatures: [],
      newDoubleSignatures: 0,
      errors: [],
      slackPosted: false,
      slackText: null,
    };
    if (mode === "off") return { ...report, reason: "mode off" };
    if (mode === "live" && this.outsideLiveWindow(now, opts)) {
      return { ...report, reason: "outside weekday 6am-8pm CT" };
    }
    report.ran = true;

    const dirs = await this.loadDirectories();
    const today = ymdInZone(now, tz);
    const window = weekdayWindow(today, 3);
    report.window = window;
    const sigStart = shiftDays(today, -Math.max(1, this.config.sigLookbackDays));
    const sigEnd = shiftDays(today, 1);

    const active = dirs.campaigns
      .filter((campaign) => String(campaign.status ?? "").trim().toUpperCase() === "ACTIVE")
      .map((campaign) => ({ campaign, client: this.clientOf(campaign, dirs) }))
      .filter((row) => row.client.clientId != null && !isNoiseCampaign(row.campaign.name));
    report.activeClientCampaigns = active.length;

    const skipRules = {
      ids: this.config.leadsSkipIds,
      clientIds: this.config.leadsSkipClientIds,
      namePatterns: this.config.leadsSkipNames,
    };
    const lanes: LeadLane[] = [];
    const sigResults: DoubleSigResult[] = [];

    const queue = [...active];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        if (!row) return;
        const { campaign, client } = row;
        const skip = leadsSkipReason(
          { id: campaign.id, name: campaign.name, clientId: client.clientId },
          skipRules,
        );
        try {
          if (!skip) {
            const analytics = await retrying(() => this.smartlead.getCampaignAnalytics(campaign.id));
            await sleep(200);
            const firstTouch = await retrying(() =>
              this.smartlead.getCampaignStatisticsPage(campaign.id, {
                limit: 1,
                sequenceNumber: 1,
                sentStartDate: window.start,
                sentEndDate: window.end,
              }),
            );
            await sleep(200);
            const root = unwrap(analytics);
            const leadStats = unwrap(root?.campaign_lead_stats);
            const parsed = parseCampaignLeadStats(analytics);
            const notStarted = numberOr(leadStats?.notStarted, parsed?.remaining ?? 0);
            const inProgress = numberOr(leadStats?.inprogress, 0);
            const total = unwrap(firstTouch)?.total_stats;
            const perDay = Math.round((numberOr(total, 0) / window.weekdays) * 10) / 10;
            lanes.push({
              id: campaign.id,
              name: campaign.name,
              clientId: client.clientId,
              clientName: client.clientName,
              notStarted,
              inProgress,
              perDay,
              daysLeft: daysLeftOf(notStarted, perDay),
            });
          }
          const sample = unwrap(
            await retrying(() =>
              this.smartlead.getCampaignStatisticsPage(campaign.id, {
                limit: 4,
                sentStartDate: sigStart,
                sentEndDate: sigEnd,
              }),
            ),
          );
          const sent = asRecordArray(sample?.data);
          const analyses = sent.map((message) => ({
            sent: typeof message.sent_time === "string" ? message.sent_time : null,
            ...analyzeSignature(message.email_message),
          }));
          const doubles = analyses.filter((entry) => entry.double);
          sigResults.push({
            id: campaign.id,
            name: campaign.name,
            clientName: client.clientName,
            sampled: analyses.length,
            doubles: doubles.length,
            lastDoubleSentAt:
              doubles
                .map((entry) => entry.sent)
                .filter((value): value is string => Boolean(value))
                .sort()
                .pop() ?? null,
          });
        } catch (error) {
          report.errors.push(`#${campaign.id}: ${errMsg(error)}`);
        }
        await sleep(300);
      }
    };
    await Promise.all([worker(), worker()]);

    report.lanesChecked = lanes.length;
    report.signatureCampaignsSampled = sigResults.filter((row) => row.sampled > 0).length;
    report.doubleSignatures = sigResults.filter((row) => row.doubles > 0);
    const flagged = lanes
      .map((lane) => ({ lane, kind: classifyLane(lane, this.config.leadsLowDays) }))
      .filter((row): row is { lane: LeadLane; kind: LaneKind } => row.kind != null)
      .sort(
        (a, b) =>
          a.lane.clientName.localeCompare(b.lane.clientName) || a.lane.id - b.lane.id,
      );
    report.flagged = flagged.map((row) => ({ ...row.lane, kind: row.kind }));

    const leadDecision = decideLeadAlerts(
      flagged,
      this.store.state.leadAlerts,
      now,
      this.config.leadsRemindHours,
    );
    const sigDecision = decideDoubleSigAlerts(sigResults, this.store.state.doubleSigs, now);
    report.alertedLanes = leadDecision.toAlert.length;
    report.newDoubleSignatures = sigDecision.toAlert.length;
    const text = formatLeadsAlert({
      header: this.header("Leads + signatures", now),
      lanes: leadDecision.toAlert,
      doubleSigs: sigDecision.toAlert,
      lowDays: this.config.leadsLowDays,
    });
    report.slackText = text;

    if (mode === "live") {
      // Only commit alert memory (and write the handoff) when the run actually saw the data.
      const incomplete = report.errors.length > Math.max(3, active.length * 0.1);
      if (incomplete) {
        report.errors.push("too many campaign errors: skipped Slack and state update");
      } else {
        if (text) {
          await this.slack.post(text);
          report.slackPosted = true;
        }
        this.store.state.leadAlerts = leadDecision.next;
        this.store.state.doubleSigs = sigDecision.next;
        report.handoffFile = await this.writeHandoff(now, flagged);
        await this.store.save();
      }
    }
    return report;
  }

  /** Refill handoff for Topup, grouped per client (same shape the routine wrote by hand). */
  private async writeHandoff(
    now: Date,
    flagged: Array<{ lane: LeadLane; kind: LaneKind }>,
  ): Promise<string | undefined> {
    if (!flagged.length) return undefined;
    const byClient: Record<string, unknown[]> = {};
    for (const { lane, kind } of flagged) {
      (byClient[lane.clientName] ??= []).push({
        id: lane.id,
        name: lane.name,
        kind,
        notStarted: lane.notStarted,
        inProgress: lane.inProgress,
        perDay: lane.perDay,
        daysLeft: lane.daysLeft,
      });
    }
    const file = path.join(this.store.dir(), `refill-handoff-${this.stamp(now)}.json`);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ takenAt: now.toISOString(), clients: byClient }, null, 2));
      return file;
    } catch (error) {
      console.warn("[watchdog] handoff write failed", errMsg(error));
      return undefined;
    }
  }

  // ------------------------------------------------------------ (c) meeting drought

  async runMeetingDrought(opts: CheckRunOptions = {}): Promise<DroughtReport> {
    const now = opts.now ?? new Date();
    const mode = this.resolveMode(this.config.droughtMode, opts);
    const tz = this.config.sendShortfallTimezone;
    const report: DroughtReport = {
      check: "meeting-drought",
      mode,
      ran: false,
      clientsChecked: 0,
      bookingsRead: 0,
      clients: [],
      uncovered: [],
      alerted: [],
      errors: [],
      slackPosted: false,
      slackText: null,
    };
    if (mode === "off") return { ...report, reason: "mode off" };
    if (mode === "live" && this.outsideLiveWindow(now, opts)) {
      return { ...report, reason: "outside weekday 6am-8pm CT" };
    }
    if (!this.supabase.enabled()) return { ...report, reason: "Supabase not configured (no booking source)" };
    report.ran = true;

    const dirs = await this.loadDirectories();
    // Active client = Smartlead client with at least one ACTIVE non-shell campaign.
    const activeClients = new Map<number, string>();
    for (const campaign of dirs.campaigns) {
      if (String(campaign.status ?? "").trim().toUpperCase() !== "ACTIVE") continue;
      if (isNoiseCampaign(campaign.name)) continue;
      const client = this.clientOf(campaign, dirs);
      if (client.clientId != null) activeClients.set(client.clientId, client.clientName);
    }

    const covered: DroughtClient[] = [];
    const uncovered: Array<{ id: number; name: string }> = [];
    for (const [clientId, name] of activeClients) {
      const slug = this.config.droughtClientSlugs[clientId];
      if (slug) covered.push({ clientId, name, slug });
      else uncovered.push({ id: clientId, name });
    }
    report.clientsChecked = covered.length;
    report.uncovered = uncovered.map((row) => row.name).sort();

    // 120 days back so "last booked" is real for clients in a long drought.
    const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
    let bookings: Array<{ clientSlug: string; createdAt: string }> = [];
    try {
      const rows = await this.supabase.fetchBookings(since);
      report.bookingsRead = rows.length;
      bookings = rows
        .filter((row) => !isTestBooking({ clientSlug: row.client_slug ?? "", leadEmail: row.lead_email }))
        .map((row) => ({ clientSlug: row.client_slug, createdAt: row.created_at }));
    } catch (error) {
      report.errors.push(`bookings: ${errMsg(error)}`);
      return report;
    }

    const statuses = computeDrought(covered, bookings, now, this.config.droughtWindowDays);
    const decision = decideDroughtAlerts(statuses, this.store.state.droughtAlerts, now, {
      minMeetings: this.config.droughtMinMeetings,
      repeatDays: this.config.droughtRepeatDays,
    });
    report.clients = statuses
      .map((status) => ({
        client: status.client.name,
        meetingsInWindow: status.meetingsInWindow,
        lastBookingAt: status.lastBookingAt,
        daysSinceLast: status.daysSinceLast,
        flagged: status.meetingsInWindow < this.config.droughtMinMeetings,
      }))
      .sort((a, b) => a.client.localeCompare(b.client));
    report.alerted = decision.toAlert.map((status) => status.client.name);

    const newGaps = uncovered.filter(
      (row) => !this.store.state.droughtGapsReported[String(row.id)],
    );
    const text = formatDroughtAlert({
      header: this.header("Meeting drought", now),
      statuses: decision.toAlert,
      windowDays: this.config.droughtWindowDays,
      timeZone: tz,
      uncoveredNames: newGaps.map((row) => row.name),
    });
    report.slackText = text;

    if (mode === "live") {
      if (text) {
        await this.slack.post(text);
        report.slackPosted = true;
      }
      this.store.state.droughtAlerts = decision.next;
      for (const gap of newGaps) {
        this.store.state.droughtGapsReported[String(gap.id)] = now.toISOString();
      }
      await this.store.save();
    }
    return report;
  }
}

/** Smartlead 429s are routine at this volume: back off and retry before giving up. */
async function retrying<T>(fn: () => Promise<T>, tries = 3, baseMs = 2000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt < tries - 1) await sleep(baseMs * (attempt + 1));
    }
  }
  throw last;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
