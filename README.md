# Campaign Watchdog

Railway app that posts weekday Slack updates to `#campaign-watchdog` (`C0BT978GSAC`). No weekend posts or Monday catch-ups. Watchdog never changes campaign settings, restaffs senders, or spends money.

**Hard rule:** Watchdog never pauses or stops a campaign, for any reason — not bounce rate, not a client-level hold, not `bounce_auto_pause_threshold`. The Smartlead client refuses `PAUSED` / `STOPPED` and logs the attempt. High bounce is Slack-only. The weekday 2-hour pulse can `START` bounce-protection holds that are already `PAUSED` (see below). It never `START`s a `STOPPED` campaign.

## What posts (final)

| Post | When | Copy |
| --- | --- | --- |
| 2-hour pulse | `PULSE_CRON` default `5 8,10,12,14,16 * * 1-5` America/Chicago. Grace until the next slot. Before the client rollup, `START`s bounce-protection holds (see Auto-resume). | `*Tue 9/1 10:00am — sent today*` then `*Client* — 400 sent · 0.5% bounce`. If any were unpaused: `Unpaused N bounce holds` (omitted when N is 0). If any client is `*under*`, that line appends a one-phrase reason. No user @-mentions unless `SLACK_MENTION_UNDER=1`. |
| Midday | `VOLUME_CRON` default `10 12 * * 1-5` America/Chicago. Projection snaps to 12:00. | `*Midday — Tue 9/1 12:00pm*` then `• *Client* \`#id\` — 200 sent → 600 proj · *under* — too few leads on ACTIVE lists` |
| Autobounce | Every 15 minutes (`CRON`), weekdays only. First-seen is seeded with no Slack. | `*Client* — *Campaign* \`#id\` auto-paused (8.2% bounce on 195 sends).` |
| Nearly done / finished | Same 15-minute watch, weekdays only, as soon as 75% / 90% / 100% is crossed. 50% is tracked in state but not Slacked. | `*Client* — *Campaign* is nearly done (75%, 238 left). Refill soon.` / `finished the list.` plus whether the client still has another ACTIVE list with leads. |
| HeyReach runway | Same 15-minute watch, weekdays only. `IN_PROGRESS` only. Call Followups `#530529` never alerts. | `*Client* — *Campaign* is nearly done (~5.8d LinkedIn runway, 21 left, 0 pending). Refill soon.` |
| EOD | `EOD_CRON` default `30 17 * * 1-5` America/Chicago. Grace until ~6:30pm the same weekday. | `*EOD — Tue 9/1*` then `• *Client* \`#id\` — 720 / 1,200 · *under* — pace short of 1,200` plus `• *Client* — 3 low on leads` (counts only; omit clients at zero). |

Pulse and midday flag `*under*` when projected &lt; 1,080 (more than 10% under the 1,200-send / 40-sender day). Pulse projection snaps to the slot hour (8/10/12/14/16). EOD compares actual sends to 1,200. Each `*under*` line appends one primary cause from live Smartlead signals already on that client (leads, inboxes, high bounce, paused lists, daily cap, or outside send window — otherwise `pace short of 1,200`). High bounce is an alert phrase only — it does not pause lists. No campaign dump. Low-on-leads is EOD-only: each ACTIVE list with remaining / 1,200 under 7 days counts as one; Josh will ask for names.

Pulse does **not** dump Off track / too-few-leads / runway essays. User @-mentions are off by default. Set `SLACK_MENTION_UNDER=1` to restore Cayden + Josh pings when a pulse line is `*under*` — still never on a clean pulse, and never for low-on-leads.

## Auto-resume bounce holds

On each weekday pulse (same `PULSE_CRON`, still Mon–Fri only), before the sent-today rollup:

1. Find `PAUSED` campaigns whose `campaign_activity_logs.paused_reason` is bounce protection, or that have a Watchdog `lastAutobounceAlertAt` stamp.
2. Skip `BOUNCE_RESUME_EXCLUDE_IDS` (defaults: `3977481,3977483,3977484,3977485,3969268,3739316,4085158,4085159,4085160`), Goliath client `548611` through `2026-10-15`, campaigns with 0 linked mailboxes or 0 remaining leads, and campaigns with no client (canary shells).
3. `POST` Smartlead status `START` for each remaining **PAUSED** campaign. Never `START` a `STOPPED` campaign.
4. Add `Unpaused N bounce holds` to the pulse when N &gt; 0.

Kill switch: `AUTO_RESUME_BOUNCE_HOLDS` (default `true`). Weekend pulses still no-op.

## Scheduled checks (moved from Campaign Watchdog bot routines)

Three deterministic checks run inside this app so the bot routines don't have to. All post **exceptions only** to the same Slack channel (`SLACK_CHANNEL_ID`, `#campaign-watchdog`), never @-mention anyone, and stay silent when there is nothing to say. Live runs only happen Mon–Fri 6am–8pm CT. State lives in `CHECKS_STATE_FILE_PATH` (default `/data/watchdog-checks-state.json`, separate from the 15-minute watch's file).

Each check has a mode flag: `off`, `dry-run` (read-only, result goes to logs/HTTP only, no Slack, no state), or `live`. **All three default to `dry-run`.** Anything unrecognised also means `dry-run`.

| Check | Flag | Cron (America/Chicago) | What it does |
| --- | --- | --- | --- |
| Paused sweep | `PAUSED_SWEEP_MODE` | `PAUSED_SWEEP_CRON` = `5 9,11,13,15,17 * * 1-5` | Josh's rule: every campaign that is `PAUSED` (including Smartlead bounce auto-pauses) gets `START`ed. Only the exact status `PAUSED` is ever startable. **Never a `STOPPED` campaign**: status is gated on the list read and re-read from Smartlead immediately before the write. Skips campaigns with no client, shells, the five Goliath campaigns (held on purpose), Gabe's call campaigns and other holdouts, the retired Vasco client, and anything with no linked senders or no leads left (those are reported once, not every run). Slack: one line per restart (with the restart count, e.g. Peterson C2 that keeps auto-pausing). The write is `START` only; the Smartlead client still refuses `PAUSED` / `STOPPED`. Runs on odd hours so it never collides with the even-hour pulse. |
| Leads + double signatures | `LEADS_CHECK_MODE` | `LEADS_CHECK_CRON` = `20 9,16 * * 1-5` | For every ACTIVE client campaign: not-started leads, and first-touch (sequence 1) sends/day over the last 3 weekdays, giving days of leads left. A lane is *dry* at 0 new leads and *low* under `LEADS_LOW_DAYS` (2). Also samples the last 4 sent emails per live campaign (last `SIG_LOOKBACK_DAYS`, default 3) for a double signature (copy sign-off followed by the mailbox signature). Slack only for lanes that newly went dry/low (or one reminder per `LEADS_REMIND_HOURS`, default 24, while still flagged) and campaigns with a newly detected double signature; recovered lanes reset silently. Live runs also write `refill-handoff-<stamp>.json` next to the state file, grouped per client, for Topup. |
| Client meeting drought | `MEETING_DROUGHT_MODE` | `MEETING_DROUGHT_CRON` = `0 8 * * 1-5` | A client with fewer than `MEETING_MIN_PER_WINDOW` (1) meetings booked in the trailing `MEETING_DROUGHT_WINDOW_DAYS` (7) is flagged (target 1–2/week). Source: the campaignintelligence booking-page log (`public.bookings`: Calendly, SavvyCal, HubSpot, MS Bookings, TidyCal, Allo), read through `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Active client = Smartlead client with at least one ACTIVE campaign. Alerts when a client first crosses, then every `MEETING_DROUGHT_REPEAT_DAYS` (7) while it stays dry. Clients with no booking source (Roofs by Peterson, Insight) are listed once as "can't check". |

Other knobs: `PAUSED_SWEEP_HOLD_IDS` (replaces the Goliath five), `PAUSED_SWEEP_EXCLUDE_IDS` and `PAUSED_SWEEP_EXCLUDE_CLIENT_IDS` (extend the defaults), `LEADS_SKIP_IDS` / `LEADS_SKIP_CLIENT_IDS` / `LEADS_SKIP_NAMES` (extend the defaults; BCP Logistics IT is skipped by name), `MEETING_CLIENT_SLUGS` (`clientId:slug,...`), `MEETING_UNCOVERED_CLIENT_IDS`.

Manual runs: `POST /checks/paused-sweep`, `POST /checks/leads`, `POST /checks/meeting-drought` (same `X-Run-Token`). Add `?dry=1` to force a read-only run that ignores the schedule window and returns the JSON report. For a local dry run against live data: `railway run -- npx tsx scripts/checks-dry-run.ts [sweep|leads|drought|all]` (never posts to Slack, never writes status or state).

The 2-hour pulse's own `AUTO_RESUME_BOUNCE_HOLDS` (bounce-protection holds only) is unchanged. The paused sweep is the broader rule and runs on the odd hours between pulses.

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

Optional: `PULSE_CRON` (default `5 8,10,12,14,16 * * 1-5`, **live again**), `VOLUME_CRON`, `EOD_CRON`, `VOLUME_TARGET_SENDS` (default 1200), `VOLUME_ALERT_MAX` (default 1080), `AUTO_RESUME_BOUNCE_HOLDS` (default on), `BOUNCE_RESUME_EXCLUDE_IDS`. Pulse @-mentions stay off unless `SLACK_MENTION_UNDER=1`; ids are `SLACK_CAYDEN_USER_ID` (default `U0BL8JT75KN`) and `SLACK_JOSH_USER_ID` (default `U0AAX2XFJE7`). Safe to leave unset on Railway.

Mount a volume at `/data` so `STATE_FILE_PATH=/data/watchdog-state.json` survives restarts.

## HTTP

- `GET /health`
- `POST /run` — 15-minute watch (`X-Run-Token` if `RUN_TOKEN` is set)
- `POST /pulse` — same token; no-ops outside weekday 8am–4pm pulse slots (plus grace)
- `POST /midday` — same token; no-ops outside the weekday noon window
- `POST /eod` — same token; no-ops outside the weekday 5–6pm window
