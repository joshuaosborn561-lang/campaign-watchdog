# Campaign Watchdog

Railway app that pings Slack when a Smartlead campaign:

- is **nearly done (75% / 90%)** so Josh/Cayden can queue a lead refill before the client goes dark
- **finishes the list (~100%)**, and says whether that **client** still has another ACTIVE campaign with leads left
- **pauses from autobounce**
- under-sends **for a real reason** (unstaffed, inboxes down, or far below what the schedule + 10-min gap allowed) — not just “short by N”

Every Slack message names the **client** and **campaign**. 50% is tracked in state but not Slacked (too early, too noisy). Canary shells, word-hunt shells, and Generic pools never get completion alerts.

Channel: `C0BT978GSAC`

## How it works

A cron (every 15 minutes, America/Chicago) walks ACTIVE/PAUSED Smartlead campaigns.

| Alert | When it fires |
| --- | --- |
| Nearly done | Crosses 75% or 90% with leads still left. Copy: `is nearly done (75%, 238 left). Refill soon.` Skipped if the campaign is already ~100% on that same pass (so a finished list never dumps 75/90/100 together). Posted as soon as the 15-minute watch sees the crossing — including after 5pm. The threshold is not marked sent until Slack succeeds. |
| Finished | Crosses ~100%. `finished the list.` If the same client has no other ACTIVE non-noise campaign with remaining leads: `This client now has nothing sending — flag for a lead refill.` If they still do: `This client still has other active campaigns with leads left.` Same posting rule as nearly-done. |
| First seen | Seeded with no Slack, so campaigns already past 75/90/100 do not dump on deploy. |
| Autobounce / pause | Campaign newly becomes `PAUSED` (15-minute watch). The 2-hour pulse and daily digest list **every** still-paused campaign by client and name, including lists left paused on purpose (e.g. Generic). Canary and word-hunt shells are ignored. |
| Sending | After that campaign's send window ends: diagnose why volume is low. Slack only if it's unstaffed, SMTP/IMAP down, or far below what leads + daily cap + 10-min gap allowed. A Parlay campaign that only had 15 scheduled does not alert. |
| Pulse | Mon–Thu 8:05am–4:05pm America/Chicago every 2 hours: emails sent + bounce per client, plus the paused campaign list. Cron fires at :05; if the 15-minute watch is still running, the pulse is queued and still posts that slot (up to ~110 minutes late). No 5pm pulse — the daily digest is the only wrap-up. Day totals use that Chicago calendar date. |

Client names come from Smartlead `client_id` first (`/client/` + `_meta.client_registry`), then campaignintelligence only when it agrees on that id. A stale `client_name` never moves another client's volume onto BCP. Untagged campaigns stay `Unknown client`. Sent totals are that campaign's analytics-by-date for the Chicago day — never lifetime or account-wide sent.

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
