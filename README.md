# Campaign Watchdog

Railway app that posts **three** weekday Slack updates to `#campaign-watchdog` (`C0BT978GSAC`) and nothing else:

1. **Midday (~12:10pm America/Chicago, Mon–Fri)** — one line per active client: sends so far and a projection to the 1,200-send / 40-sender day. Flags `*under*` when projected &lt; 1,080.
2. **Event** — as soon as a campaign is auto-paused by bounce protection (15-minute watch, weekdays only).
3. **End of day (~5:30pm America/Chicago, Mon–Fri)** — one line per active client: sends today vs 1,200, plus `needs top-up` when remaining leads are under 7 days at 1,200/day.

No weekend runs or Monday catch-ups. Watchdog never changes campaign settings, pauses/resumes lists, restaffs senders, or spends money.

## What no longer posts

Removed from Slack (still may be computed internally or left in lib tests):

- 2-hour **pulse** walls (`Fri 10/2 10:00am — sent today` plus the huge **Off track** campaign list)
- Nightly **daily digest** (campaign-by-campaign “still waiting / finished today / paused”)
- **75% / 90% / 100%** nearly-done and finished-list refill pings
- **HeyReach** LinkedIn runway / pending-dry alerts
- Standing / manual **pause** names (only bounce-protection auto-pauses Slack)

## How it works

| Post | When | Copy |
| --- | --- | --- |
| Midday | `VOLUME_CRON` default `10 12 * * 1-5` America/Chicago. Projection snaps to 12:00 so a late drain still uses noon math. | `*Midday — Tue 9/1 12:00pm*` then `• *Client* \`#id\` — 200 sent → 600 proj · *under*` |
| Autobounce | Every 15 minutes (`CRON`), weekdays only. First-seen campaigns are seeded with no Slack. | `*Client* — *Campaign* \`#id\` auto-paused (8.2% bounce on 195 sends).` |
| EOD | `EOD_CRON` default `30 17 * * 1-5` America/Chicago. Grace until ~6:30pm the same weekday; no 7pm/weekend wrap-up. | `*EOD — Tue 9/1*` then `• *Client* \`#id\` — 720 / 1,200 · *under* · *~4.2d left, needs top-up*` |

**Projection:** union of that client's ACTIVE Smartlead send windows (real `scheduler_cron_value` when present, else 9:00–17:00 CT). At noon a 9:00–18:00 window is one third of the day, so projected = today × 3. Windows in other timezones are converted to Chicago minutes.

**Top-up:** remaining = `notStarted + inProgress` across ACTIVE lists. Days left = remaining / 1,200. Flag when that is under 7.

**Skip:** canary / word-hunt / pod-control shells and the pulse-exclude leftovers (Nieto / MSRS / Positive). Clients with no ACTIVE send-day campaigns are omitted. Paused-only clients do not appear on midday/EOD.

Client names come from Smartlead `client_id` first (`/client/` + `_meta.client_registry`). Sent totals are that campaign's analytics-by-date for the Chicago day — never lifetime.

## Env

See `.env.example`. Minimum:

- `SMARTLEAD_API_KEY`
- `SLACK_BOT_TOKEN` or rotating `SLACK_ACCESS_TOKEN` + `SLACK_REFRESH_TOKEN` + Slack app client id/secret
- `SLACK_CHANNEL_ID=C0BT978GSAC`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (client names + alert dedupe)

Optional: `VOLUME_CRON`, `EOD_CRON`, `VOLUME_TARGET_SENDS` (default 1200), `VOLUME_ALERT_MAX` (default 1080). Existing `PULSE_CRON` / HeyReach keys are ignored for Slack (safe to leave on Railway).

Mount a volume at `/data` so `STATE_FILE_PATH=/data/watchdog-state.json` survives restarts.

## HTTP

- `GET /health`
- `POST /run` — 15-minute autobounce scan (`X-Run-Token` if `RUN_TOKEN` is set)
- `POST /midday` — same token; no-ops outside the weekday noon window
- `POST /eod` — same token; no-ops outside the weekday 5–6pm window
