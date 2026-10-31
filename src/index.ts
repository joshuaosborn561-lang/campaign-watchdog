import express from "express";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { SlackClient } from "./clients/slack.js";
import { SmartleadClient } from "./clients/smartlead.js";
import { SupabaseStore } from "./clients/supabase.js";
import { ChecksService } from "./services/checks.js";
import { WatchService } from "./services/watch.js";
import { ChecksStore } from "./state/checks-store.js";
import { StateStore } from "./state/store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.stateFilePath);
  await state.load();

  const supabase = new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey);
  const storedSlack =
    state.slackTokens() ??
    (supabase.enabled() ? await supabase.readSlackTokens().catch(() => null) : null);

  const slack = new SlackClient({
    channelId: config.slackChannelId,
    botToken: config.slackBotToken,
    accessToken: storedSlack?.access_token || config.slackAccessToken,
    refreshToken: storedSlack?.refresh_token || config.slackRefreshToken,
    clientId: config.slackClientId,
    clientSecret: config.slackClientSecret,
    tokenFilePath: config.stateFilePath.replace(/watchdog-state\.json$/, "slack-tokens.json"),
  });

  const smartlead = new SmartleadClient(config.smartleadApiKey);
  const watch = new WatchService(config, smartlead, slack, state, supabase);

  const checksStore = new ChecksStore(config.checksStateFilePath);
  await checksStore.load();
  const checks = new ChecksService(config, smartlead, slack, supabase, checksStore);
  /** One run per check at a time; the checks are independent of the 15-minute watch. */
  const checkBusy = new Set<string>();
  const runCheck = async (name: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (checkBusy.has(name)) {
      console.log(`[watchdog] skip ${name}: already running`);
      return { skipped: "already running" };
    }
    checkBusy.add(name);
    try {
      await checksStore.load();
      const report = await fn();
      await persistTokens();
      return report;
    } catch (error) {
      console.error(`[watchdog] ${name} failed`, error);
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      checkBusy.delete(name);
    }
  };
  const summarize = (report: unknown): string => {
    const r = report as Record<string, unknown>;
    if (!r || typeof r !== "object") return String(report);
    if (r.check === "paused-sweep") {
      return `mode=${r.mode} paused=${r.pausedTotal} client=${r.clientPaused} wouldStart=${(r.wouldStart as unknown[])?.length} started=${(r.started as unknown[])?.length} errors=${(r.errors as unknown[])?.length}`;
    }
    if (r.check === "leads-and-signatures") {
      return `mode=${r.mode} lanes=${r.lanesChecked} flagged=${(r.flagged as unknown[])?.length} alerted=${r.alertedLanes} doubles=${(r.doubleSignatures as unknown[])?.length} newDoubles=${r.newDoubleSignatures} errors=${(r.errors as unknown[])?.length}`;
    }
    return `mode=${r.mode} clients=${r.clientsChecked} alerted=${(r.alerted as unknown[])?.length} errors=${(r.errors as unknown[])?.length}`;
  };

  let running = false;
  type ScheduledJob = { kind: "pulse" | "midday" | "eod"; reason: string; firedAt: Date };
  const queued: ScheduledJob[] = [];

  const persistTokens = async () => {
    const tokens = slack.tokenBundle();
    state.setSlackTokens({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    });
    if (supabase.enabled() && tokens.refreshToken) {
      await supabase
        .writeSlackTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        })
        .catch((error) => console.warn("[watchdog] slack token persist failed", error));
    }
  };

  const drainQueued = () => {
    running = false;
    const job = queued.shift();
    if (!job) return;
    if (job.kind === "midday") void runMidday(job.reason, job.firedAt);
    else if (job.kind === "eod") void runEod(job.reason, job.firedAt);
    else void runPulse(job.reason, job.firedAt);
  };

  const runOnce = async (reason: string) => {
    if (running) {
      console.log(`[watchdog] skip ${reason}: already running`);
      return;
    }
    running = true;
    const started = Date.now();
    try {
      await state.load();
      const result = await watch.run();
      await persistTokens();
      await state.save();
      console.log(
        `[watchdog] ${reason} scanned=${result.scanned} completion=${result.completion} autobounce=${result.autobounce} heyreach=${result.heyreach} errors=${result.errors.length} ${Date.now() - started}ms`,
      );
      if (result.errors.length) {
        console.warn("[watchdog] errors", result.errors.slice(0, 20));
      }
    } catch (error) {
      console.error("[watchdog] run failed", error);
    } finally {
      drainQueued();
    }
  };

  const runPulse = async (reason: string, firedAt = new Date()) => {
    if (running) {
      queued.push({ kind: "pulse", reason, firedAt });
      console.log(`[watchdog] queue ${reason}: watch busy`);
      return;
    }
    running = true;
    try {
      await state.load();
      const pulse = await watch.runPulse(firedAt);
      console.log(
        `[watchdog] ${reason} posted=${pulse.posted} clients=${pulse.clients} under=${pulse.under} paused=${pulse.paused} unpaused=${pulse.unpaused}`,
      );
    } catch (error) {
      console.error("[watchdog] pulse failed", error);
    } finally {
      drainQueued();
    }
  };

  const runMidday = async (reason: string, firedAt = new Date()) => {
    if (running) {
      queued.push({ kind: "midday", reason, firedAt });
      console.log(`[watchdog] queue ${reason}: watch busy`);
      return;
    }
    running = true;
    try {
      await state.load();
      const volume = await watch.runVolumeCheck(firedAt);
      console.log(
        `[watchdog] ${reason} posted=${volume.posted} clients=${volume.clients} flagged=${volume.flagged}`,
      );
    } catch (error) {
      console.error("[watchdog] midday failed", error);
    } finally {
      drainQueued();
    }
  };

  const runEod = async (reason: string, firedAt = new Date()) => {
    if (running) {
      queued.push({ kind: "eod", reason, firedAt });
      console.log(`[watchdog] queue ${reason}: watch busy`);
      return;
    }
    running = true;
    try {
      await state.load();
      const eod = await watch.runEndOfDay(firedAt);
      console.log(
        `[watchdog] ${reason} posted=${eod.posted} clients=${eod.clients} under=${eod.under} topUp=${eod.topUp}`,
      );
    } catch (error) {
      console.error("[watchdog] eod failed", error);
    } finally {
      drainQueued();
    }
  };

  const authorize = (req: express.Request, res: express.Response): boolean => {
    if (config.runToken && req.header("x-run-token") !== config.runToken) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  };

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "campaign-watchdog" });
  });
  app.post("/run", async (req, res) => {
    if (!authorize(req, res)) return;
    await runOnce("manual");
    res.json({ ok: true });
  });
  app.post("/pulse", async (req, res) => {
    if (!authorize(req, res)) return;
    await runPulse("manual-pulse");
    res.json({ ok: true });
  });
  app.post("/midday", async (req, res) => {
    if (!authorize(req, res)) return;
    await runMidday("manual-midday");
    res.json({ ok: true });
  });
  app.post("/eod", async (req, res) => {
    if (!authorize(req, res)) return;
    await runEod("manual-eod");
    res.json({ ok: true });
  });

  /** `?dry=1` forces read-only / log-only whatever the configured mode is. */
  const checkRoute =
    (name: string, fn: (opts: { forceDryRun: boolean; ignoreSchedule: boolean }) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      if (!authorize(req, res)) return;
      const dry = req.query.dry === "1" || req.query.dry === "true";
      const report = await runCheck(name, () => fn({ forceDryRun: dry, ignoreSchedule: dry }));
      res.json({ ok: true, report });
    };
  app.post("/checks/paused-sweep", checkRoute("paused-sweep", (o) => checks.runPausedSweep(o)));
  app.post("/checks/leads", checkRoute("leads", (o) => checks.runLeadsCheck(o)));
  app.post("/checks/meeting-drought", checkRoute("meeting-drought", (o) => checks.runMeetingDrought(o)));

  app.listen(config.port, config.host, () => {
    console.log(`[watchdog] listening on ${config.host}:${config.port}`);
  });

  cron.schedule(
    config.cron,
    () => {
      void runOnce("cron");
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.pulseCron,
    () => {
      void runPulse("pulse", new Date());
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.volumeCron,
    () => {
      void runMidday("midday", new Date());
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.eodCron,
    () => {
      void runEod("eod", new Date());
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.pausedSweepCron,
    () => {
      void runCheck("paused-sweep", () => checks.runPausedSweep()).then((report) =>
        console.log(`[watchdog] paused-sweep ${summarize(report)}`),
      );
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.leadsCheckCron,
    () => {
      void runCheck("leads", () => checks.runLeadsCheck()).then((report) =>
        console.log(`[watchdog] leads-check ${summarize(report)}`),
      );
    },
    { timezone: config.sendShortfallTimezone },
  );
  cron.schedule(
    config.droughtCron,
    () => {
      void runCheck("meeting-drought", () => checks.runMeetingDrought()).then((report) =>
        console.log(`[watchdog] meeting-drought ${summarize(report)}`),
      );
    },
    { timezone: config.sendShortfallTimezone },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});