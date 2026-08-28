# Campaign Watchdog

Railway app that pings Slack when a Smartlead campaign:

- hits **50% / 75% / 90% / 100%** completion
- **pauses from autobounce**
- under-sends **for a real reason** (unstaffed, inboxes down, or far below what the schedule + 10-min gap allowed) — not just “short by N”

Every Slack message names the **client** and **campaign**.

Channel: `C0BT978GSAC`

## How it works

A cron (every 15 minutes) walks ACTIVE/PAUSED Smartlead campaigns.

| Alert | When it fires |
| --- | --- |
| Completion | Lead contacted / total crosses 50, 75, 90, or ~100%. First observation is seeded with no Slack. |
| Autobounce / pause | Campaign newly becomes `PAUSED` (15-minute watch). The 2-hour client pulse also lists every still-paused campaign by client and name. Canary shells are ignored. |
| Sending | After that campaign's send window ends: diagnose why volume is low. Slack only if it's unstaffed, SMTP/IMAP down, or far below what leads + daily cap + 10-min gap allowed. A Parlay campaign that only had 15 scheduled does not alert. |
| Pulse | Mon–Thu 8am–5pm ET every 2 hours: emails sent + bounce per client, plus the paused campaign list. |

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
- `POST /pulse` with the same token — client sent/bounce + paused campaigns
