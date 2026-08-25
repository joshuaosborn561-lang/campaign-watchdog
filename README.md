# Campaign Watchdog

Railway app that pings Slack when a Smartlead campaign:

- hits **50% / 75% / 90% / 100%** completion
- **pauses from autobounce**
- sends **under 30 emails per inbox that day** (target = `30 × inbox count` for that campaign)

Every Slack message names the **client** and **campaign**.

Channel: `C0BT978GSAC`

## How it works

A cron (every 15 minutes) walks ACTIVE/PAUSED Smartlead campaigns.

| Alert | When it fires |
| --- | --- |
| Completion | Lead contacted / total crosses 50, 75, 90, or ~100%. First observation is seeded so a deploy does not dump historical crossings. |
| Autobounce | Campaign newly becomes `PAUSED` and bounce rate is at/over Smartlead's `bounce_auto_pause_threshold` (default 5%), or Smartlead labels the pause as autobounce. |
| Sending | After 5pm America/New_York on weekdays: today's sent count is below `MESSAGE_PER_DAY × attached inboxes`. One alert per campaign per day. |

Client names come from campaignintelligence (`public.campaigns.client_name`) with fallbacks to `_meta.client_registry` and Smartlead `/client/`.

## Env

See `.env.example`. Minimum:

- `SMARTLEAD_API_KEY`
- `SLACK_BOT_TOKEN` or rotating `SLACK_ACCESS_TOKEN` + `SLACK_REFRESH_TOKEN` + Slack app client id/secret
- `SLACK_CHANNEL_ID=C0BT978GSAC`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (client names + alert dedupe)

Mount a volume at `/data` so `STATE_FILE_PATH=/data/watchdog-state.json` survives restarts.

## HTTP

- `GET /health`
- `POST /run` with `X-Run-Token` if `RUN_TOKEN` is set
