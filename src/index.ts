import express from "express";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { SlackClient } from "./clients/slack.js";
import { SmartleadClient } from "./clients/smartlead.js";
import { SupabaseStore } from "./clients/supabase.js";
import { WatchService } from "./services/watch.js";
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

  let running = false;
  let queued: { kind: "midday" | "eod"; reason: string; firedAt: Date } | null = null;

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
    if (!queued) return;
    const job = queued;
    queued = null;
    if (job.kind === "midday") void runMidday(job.reason, job.firedAt);
    else void runEod(job.reason, job.firedAt);
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

  const runMidday = async (reason: string, firedAt = new Date()) => {
    if (running) {
      queued = { kind: "midday", reason, firedAt };
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
      queued = { kind: "eod", reason, firedAt };
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
