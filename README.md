# Campaign Watchdog

Railway app that posts weekday Slack updates to `#campaign-watchdog` (`C0BT978GSAC`). No weekend posts or Monday catch-ups. Watchdog never changes campaign settings, pauses/resumes lists, restaffs senders, or spends money.

## What posts (final)

| Post | When | Copy |
| --- | --- | --- |
| Midday | `VOLUME_CRON` default `10 12 * * 1-5` America/Chicago. Projection snaps to 12:00. | `*Midday — Tue 9/1 12:00pm*` then `• *Client* \`#id\` — 200 sent → 600 proj · *under*` |
| Autobounce | Every 15 minutes (`CRON`), weekdays only. First-seen is seeded with no Slack. | `*Client* — *Campaign* \`#id\` auto-paused (8.2% bounce on 195 sends).` |
| Nearly done / finished | Same 15-minute watch, weekdays only, as soon as 75% / 90% / 100% is crossed. 50% is tracked in state but not Slacked. | `*Client* — *Campaign* is nearly done (75%, 238 left). Refill soon.` / `finished the list.` plus whether the client still has another ACTIVE list with leads. |
| HeyReach runway | Same 15-minute watch, weekdays only. `IN_PROGRESS` only. Call Followups `#530529` never alerts. | `*Client* — *Campaign* is nearly done (~5.8d LinkedIn runway, 21 left, 0 pending). Refill soon.` |
| EOD | `EOD_CRON` default `30 17 * * 1-5` America/Chicago. Grace until ~6:30pm the same weekday. | `*EOD — Tue 9/1*` then `• *Client* \`#id\` — 720 / 1,200 · *under* · *~4.2d left, needs top-up*` |

Midday flags `*under*` when projected &lt; 1,080 (more than 10% under the 1,200-send / 40-sender day). EOD compares actual sends to 1,200 and flags a client when remaining leads / 1,200 is under 7 days.

## What no longer posts

- 2-hour **pulse** walls (`Fri 10/2 10:00am — sent today` plus the huge **Off track** campaign list)
- Nightly **daily digest** (campaign-by-campaign “still waiting / finished today / paused”), including the Saturday 11pm wrap-up
- Standing / manual **pause** names (only bounce-protection auto-pauses Slack)

## How volume math works

**Projection:** union of that client's ACTIVE Smartlead send windows (real `scheduler_cron_value` when present, else 9:00–17:00 CT). At noon a 9:00–18:00 window is one third of the day, so projected = today × 3. Windows in other timezones are converted to Chicago minutes.

**Top-up:** remaining = `notStarted + inProgress` across ACTIVE lists. Days left = remaining / 1,200.

**Skip (midday/EOD):** canary / word-hunt / pod-control shells and the pulse-exclude leftovers (Nieto / MSRS / Positive). Clients with no ACTIVE send-day campaigns are omitted.

Client names come from Smartlead `client_id` first (`/client/` + `_meta.client_registry`). Sent totals are that campaign's analytics-by-date for the Chicago day — never lifetime.

## Env

See `.env.example`. Minimum:

- `SMARTLEAD_API_KEY`
- `SLACK_BOT_TOKEN` or rotating `SLACK_ACCESS_TOKEN` + `SLACK_REFRESH_TOKEN` + Slack app client id/secret
- `SLACK_CHANNEL_ID=C0BT978GSAC`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (client names + alert dedupe)
- Optional HeyReach workspace keys: `HEYREACH_SALESGLIDER_API_KEY`, `HEYREACH_TECHEVO_API_KEY`

Optional: `VOLUME_CRON`, `EOD_CRON`, `VOLUME_TARGET_SENDS` (default 1200), `VOLUME_ALERT_MAX` (default 1080). Existing `PULSE_CRON` is ignored (safe to leave on Railway).

Mount a volume at `/data` so `STATE_FILE_PATH=/data/watchdog-state.json` survives restarts.

## HTTP

- `GET /health`
- `POST /run` — 15-minute watch (`X-Run-Token` if `RUN_TOKEN` is set)
- `POST /midday` — same token; no-ops outside the weekday noon window
- `POST /eod` — same token; no-ops outside the weekday 5–6pm window
