# Campaign Watchdog

Railway app that posts weekday Slack updates to `#campaign-watchdog` (`C0BT978GSAC`). No weekend posts or Monday catch-ups. Watchdog never changes campaign settings, restaffs senders, or spends money. The weekday 2-hour pulse can `START` bounce-protection holds (see below); it does not pause lists.

## What posts (final)

| Post | When | Copy |
| --- | --- | --- |
| 2-hour pulse | `PULSE_CRON` default `5 8,10,12,14,16 * * 1-5` America/Chicago. Grace until the next slot. Before the client rollup, `START`s bounce-protection holds (see Auto-resume). | `*Tue 9/1 10:00am — sent today*` then `*Client* — 400 sent · 0.5% bounce`. If any were unpaused: `Unpaused N bounce holds` (omitted when N is 0). If any client is `*under*`, the post starts with `<@Cayden> <@Josh>` and that line appends a one-phrase reason. |
| Midday | `VOLUME_CRON` default `10 12 * * 1-5` America/Chicago. Projection snaps to 12:00. | `*Midday — Tue 9/1 12:00pm*` then `• *Client* \`#id\` — 200 sent → 600 proj · *under* — too few leads on ACTIVE lists` |
| Autobounce | Every 15 minutes (`CRON`), weekdays only. First-seen is seeded with no Slack. | `*Client* — *Campaign* \`#id\` auto-paused (8.2% bounce on 195 sends).` |
| Nearly done / finished | Same 15-minute watch, weekdays only, as soon as 75% / 90% / 100% is crossed. 50% is tracked in state but not Slacked. | `*Client* — *Campaign* is nearly done (75%, 238 left). Refill soon.` / `finished the list.` plus whether the client still has another ACTIVE list with leads. |
| HeyReach runway | Same 15-minute watch, weekdays only. `IN_PROGRESS` only. Call Followups `#530529` never alerts. | `*Client* — *Campaign* is nearly done (~5.8d LinkedIn runway, 21 left, 0 pending). Refill soon.` |
| EOD | `EOD_CRON` default `30 17 * * 1-5` America/Chicago. Grace until ~6:30pm the same weekday. | `*EOD — Tue 9/1*` then `• *Client* \`#id\` — 720 / 1,200 · *under* — pace short of 1,200` plus `• *Client* — 3 low on leads` (counts only; omit clients at zero). |

Pulse and midday flag `*under*` when projected &lt; 1,080 (more than 10% under the 1,200-send / 40-sender day). Pulse projection snaps to the slot hour (8/10/12/14/16). EOD compares actual sends to 1,200. Each `*under*` line appends one primary cause from live Smartlead signals already on that client (leads, inboxes, bounce hold, paused lists, daily cap, or outside send window — otherwise `pace short of 1,200`). No campaign dump. Low-on-leads is EOD-only: each ACTIVE list with remaining / 1,200 under 7 days counts as one; Josh will ask for names.

Pulse does **not** dump Off track / too-few-leads / runway essays. Mentions fire only when at least one pulse line is `*under*` — never on a clean pulse, and never for low-on-leads.

## Auto-resume bounce holds

On each weekday pulse (same `PULSE_CRON`, still Mon–Fri only), before the sent-today rollup:

1. Find `PAUSED` campaigns whose `campaign_activity_logs.paused_reason` is bounce protection, or that have a Watchdog `lastAutobounceAlertAt` stamp.
2. Skip `BOUNCE_RESUME_EXCLUDE_IDS` (defaults: `3977481,3977483,3977484,3977485,3969268,3739316,4085158,4085159,4085160`), Goliath client `548611` through `2026-10-15`, campaigns with 0 linked mailboxes or 0 remaining leads, and campaigns with no client (canary shells).
3. `POST` Smartlead status `START` for each remaining campaign.
4. Add `Unpaused N bounce holds` to the pulse when N &gt; 0.

Kill switch: `AUTO_RESUME_BOUNCE_HOLDS` (default `true`). Weekend pulses still no-op.

## What no longer posts

- Huge **Off track** campaign lists on the 2-hour pulse
- Nightly **daily digest** (campaign-by-campaign “still waiting / finished today / paused”), including the Saturday 11pm wrap-up
- Standing / manual **pause** names (only bounce-protection auto-pauses Slack; pulse still shows a paused *count*)

## How volume math works

**Projection:** union of that client's ACTIVE Smartlead send windows (real `scheduler_cron_value` when present, else 9:00–17:00 CT). At noon a 9:00–18:00 window is one third of the day, so projected = today × 3. At the 10am pulse the same window is 1/9 elapsed. Windows in other timezones are converted to Chicago minutes. A window that has not started yet is not projected (no `*under*` at 8am for a 9am start).

**Low on leads (EOD):** remaining = `notStarted + inProgress` on each ACTIVE list. Days left = remaining / 1,200. A list is low when days left &lt; 7. EOD prints the **count** per client, not campaign names or “needs top-up” copy.

**Skip (pulse/midday/EOD):** canary / word-hunt / pod-control shells and the pulse-exclude leftovers (Nieto / MSRS / Positive). Clients with no ACTIVE send-day campaigns are omitted from midday/EOD volume lines.

Client names come from Smartlead `client_id` first (`/client/` + `_meta.client_registry`). Sent totals are that campaign's analytics-by-date for the Chicago day — never lifetime.

## Env

See `.env.example`. Minimum:

- `SMARTLEAD_API_KEY`
- `SLACK_BOT_TOKEN` or rotating `SLACK_ACCESS_TOKEN` + `SLACK_REFRESH_TOKEN` + Slack app client id/secret
- `SLACK_CHANNEL_ID=C0BT978GSAC`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (client names + alert dedupe)
- Optional HeyReach workspace keys: `HEYREACH_SALESGLIDER_API_KEY`, `HEYREACH_TECHEVO_API_KEY`

Optional: `PULSE_CRON` (default `5 8,10,12,14,16 * * 1-5`, **live again**), `VOLUME_CRON`, `EOD_CRON`, `VOLUME_TARGET_SENDS` (default 1200), `VOLUME_ALERT_MAX` (default 1080), `AUTO_RESUME_BOUNCE_HOLDS` (default on), `BOUNCE_RESUME_EXCLUDE_IDS`. Pulse under-mentions use `SLACK_CAYDEN_USER_ID` (default `U0BL8JT75KN`) and `SLACK_JOSH_USER_ID` (default `U0AAX2XFJE7`). Safe to leave unset on Railway unless you need to override.

Mount a volume at `/data` so `STATE_FILE_PATH=/data/watchdog-state.json` survives restarts.

## HTTP

- `GET /health`
- `POST /run` — 15-minute watch (`X-Run-Token` if `RUN_TOKEN` is set)
- `POST /pulse` — same token; no-ops outside weekday 8am–4pm pulse slots (plus grace)
- `POST /midday` — same token; no-ops outside the weekday noon window
- `POST /eod` — same token; no-ops outside the weekday 5–6pm window
