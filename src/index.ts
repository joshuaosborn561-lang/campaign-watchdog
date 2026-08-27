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
  const runOnce = async (reason: string) => {
    if (running) {
      console.log(`[watchdog] skip ${reason}: already running`);
      return;
    }
    running = true;
    const started = Date.now();
    try {
      const result = await watch.run();
      const tokens = slack.tokenBundle();
      state.setSlackTokens({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (supabase.enabled() && tokens.refreshToken) {
        await supabase.writeSlackTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }).catch((error) => console.warn("[watchdog] slack token persist failed", error));
      }
      await state.save();
      console.log(
        `[watchdog] ${reason} scanned=${result.scanned} completion=${result.completion} autobounce=${result.autobounce} sending=${result.sending} digest=${result.digest} errors=${result.errors.length} ${Date.now() - started}ms`,
      );
      if (result.errors.length) {
        console.warn("[watchdog] errors", result.errors.slice(0, 20));
      }
    } catch (error) {
      console.error("[watchdog] run failed", error);
    } finally {
      running = false;
    }
  };

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "campaign-watchdog" });
  });
  app.post("/run", async (req, res) => {
    if (config.runToken && req.header("x-run-token") !== config.runToken) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    await runOnce("manual");
    res.json({ ok: true });
  });

  const runPulse = async (reason: string) => {
    if (running) {
      console.log(`[watchdog] skip ${reason}: already running`);
      return;
    }
    running = true;
    try {
      const pulse = await watch.runPulse();
      console.log(
        `[watchdog] ${reason} posted=${pulse.posted} clients=${pulse.clients}`,
      );
    } catch (error) {
      console.error("[watchdog] pulse failed", error);
    } finally {
      running = false;
    }
  };

  app.post("/pulse", async (req, res) => {
    if (config.runToken && req.header("x-run-token") !== config.runToken) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    await runPulse("manual-pulse");
    res.json({ ok: true });
  });

  app.listen(config.port, config.host, () => {
    console.log(`[watchdog] listening on ${config.host}:${config.port}`);
  });

  cron.schedule(config.cron, () => {
    void runOnce("cron");
  });
  cron.schedule(
    config.pulseCron,
    () => {
      void runPulse("pulse");
    },
    { timezone: config.sendShortfallTimezone },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
