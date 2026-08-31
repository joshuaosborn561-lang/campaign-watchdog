# Campaign Watchdog

Railway app that pings Slack when a Smartlead campaign:

- is **nearly done (75% / 90%)** so Josh/Cayden can queue a lead refill before the client goes dark
- **finishes the list (~100%)**, and says whether that **client** still has another ACTIVE campaign with leads left
- **pauses from autobounce**
- under-sends **for a real reason** (unstaffed, inboxes down, or far below what the schedule + 10-min gap allowed) — not just “short by N”

Every Slack message names the **client** and **campaign**. 50% is tracked in state but not Slacked (too early, too noisy). Canary shells, word-hunt shells, and Generic pools never get completion alerts.

Channel: `C0BT978GSAC`

## How it works

A cron (every 15 minutes) walks ACTIVE/PAUSED Smartlead campaigns.

| Alert | When it fires |
| --- | --- |
| Nearly done | Crosses 75% or 90% with leads still left. Copy: `is nearly done (75%, 238 left). Refill soon.` Skipped if the campaign is already ~100% on that same pass (so a finished list never dumps 75/90/100 together). |
| Finished | Crosses ~100%. `finished the list.` If the same client has no other ACTIVE non-noise campaign with remaining leads: `This client now has nothing sending — flag for a lead refill.` If they still do: `This client still has other active campaigns with leads left.` |
| First seen | Seeded with no Slack, so campaigns already past 75/90/100 do not dump on deploy. |
| Autobounce / pause | Campaign newly becomes `PAUSED` (15-minute watch). The 2-hour pulse and daily digest list **every** still-paused campaign by client and name, including lists left paused on purpose (e.g. Generic). Canary and word-hunt shells are ignored. |
| Sending | After that campaign's send window ends: diagnose why volume is low. Slack only if it's unstaffed, SMTP/IMAP down, or far below what leads + daily cap + 10-min gap allowed. A Parlay campaign that only had 15 scheduled does not alert. |
| Pulse | Mon–Thu 8:05am–4:05pm ET every 2 hours: emails sent + bounce per client, plus the paused campaign list. Runs after the 15-minute watch if that scan is still going. No 5pm pulse — the daily digest is the only wrap-up. |

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
