import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCampaignSchedule, type CampaignSchedule } from "./schedule.js";
import { clockMinutesInZone } from "./time.js";
import {
  DEFAULT_VOLUME_WEEKDAYS,
  VOLUME_ALERT_MAX,
  VOLUME_TARGET_SENDS,
  emailDaysLeft,
  flagUnderVolume,
  formatEodReport,
  formatMiddayReport,
  isVolumeSkippedCampaign,
  needsEmailTopUp,
  projectDayTotal,
  resolveEodSlot,
  resolveVolumeSlot,
  rollupClientEod,
  rollupClientVolume,
  scheduleWindowMinutesInZone,
  unionClientWindow,
  volumeAlertMax,
  windowElapsedFraction,
  type ClientVolumeRow,
} from "./volume.js";

const CHICAGO = "America/Chicago";
const defaults = { timeZone: CHICAGO, gapMinutes: 10 };

function volumeRow(partial: Partial<ClientVolumeRow> & Pick<ClientVolumeRow, "clientName" | "sent" | "projected">): ClientVolumeRow {
  return {
    clientId: partial.clientId ?? null,
    remaining: partial.remaining ?? null,
    daysLeft: partial.daysLeft ?? null,
    under: partial.under ?? partial.projected < VOLUME_ALERT_MAX,
    needsTopUp: partial.needsTopUp ?? false,
    fraction: partial.fraction ?? 1 / 3,
    startMinutes: partial.startMinutes ?? 540,
    endMinutes: partial.endMinutes ?? 1080,
    ...partial,
  };
}

function schedule(partial: Partial<CampaignSchedule> = {}): CampaignSchedule {
  return {
    timeZone: CHICAGO,
    days: [1, 2, 3, 4, 5],
    startHour: 9,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    gapMinutes: 10,
    maxLeadsPerDay: null,
    ...partial,
  };
}

/** Tue 9/1/2026 12:00pm America/Chicago (CDT). */
const noonTue = new Date("2026-09-01T17:00:00.000Z");
/** Sat 9/5/2026 12:00pm America/Chicago. */
const noonSat = new Date("2026-09-05T17:00:00.000Z");
/** Sun 9/6/2026 12:00pm America/Chicago. */
const noonSun = new Date("2026-09-06T17:00:00.000Z");
/** Fri 8/28/2026 12:10pm America/Chicago. */
const friday1210 = new Date("2026-08-28T17:10:00.000Z");

describe("send-volume projection", () => {
  it("treats noon as one third of a 9:00–18:00 window", () => {
    assert.equal(windowElapsedFraction(9 * 60, 18 * 60, 12 * 60), 1 / 3);
    assert.equal(projectDayTotal(300, 1 / 3), 900);
  });

  it("flags when projected is more than 10% under 1,200", () => {
    assert.equal(volumeAlertMax(), 1080);
    assert.equal(VOLUME_ALERT_MAX, 1080);
    assert.equal(VOLUME_TARGET_SENDS, 1200);
    const flagged = flagUnderVolume([
      volumeRow({ clientId: 1, clientName: "Goliath", sent: 300, projected: 900 }),
      volumeRow({ clientId: 2, clientName: "On Pace", sent: 360, projected: 1080 }),
      volumeRow({ clientId: 3, clientName: "Barely under", sent: 359, projected: 1077 }),
    ]);
    assert.deepEqual(
      flagged.map((row) => row.clientName),
      ["Goliath", "Barely under"],
    );
  });

  it("does not project before the window starts", () => {
    assert.equal(windowElapsedFraction(13 * 60, 18 * 60, 12 * 60), null);
    assert.equal(projectDayTotal(0, 0), 0);
  });

  it("uses sent-so-far once the window has ended", () => {
    assert.equal(windowElapsedFraction(6 * 60, 11 * 60, 12 * 60), 1);
    assert.equal(projectDayTotal(400, 1), 400);
  });

  it("rolls a client to the union of real ACTIVE schedules", () => {
    const rows = rollupClientVolume(
      [
        {
          clientId: 10,
          clientName: "TechEvolution",
          sent: 100,
          schedule: schedule({ startHour: 9, endHour: 17 }),
        },
        {
          clientId: 10,
          clientName: "TechEvolution",
          sent: 200,
          schedule: schedule({ startHour: 10, endHour: 18 }),
        },
      ],
      noonTue,
      CHICAGO,
    );
    assert.equal(rows.length, 1);
    // Union 9:00–18:00 CT; noon is 1/3; 300 × 3 = 900
    assert.equal(rows[0].sent, 300);
    assert.equal(rows[0].startMinutes, 9 * 60);
    assert.equal(rows[0].endMinutes, 18 * 60);
    assert.equal(rows[0].projected, 900);
  });

  it("converts a New York window onto Chicago minutes", () => {
    const ny = parseCampaignSchedule(
      {
        tz: "America/New_York",
        startHour: "09:00",
        endHour: "17:00",
      },
      defaults,
    );
    const window = scheduleWindowMinutesInZone(ny, noonTue, CHICAGO);
    // 9am–5pm ET is 8am–4pm CT in September.
    assert.equal(window.start, 8 * 60);
    assert.equal(window.end, 16 * 60);
    assert.equal(
      clockMinutesInZone(9 * 60, "America/New_York", CHICAGO, noonTue),
      8 * 60,
    );
    const union = unionClientWindow([ny], noonTue, CHICAGO);
    const fraction = windowElapsedFraction(union!.start, union!.end, 12 * 60);
    // 8am–4pm CT, noon is 4/8 = 1/2
    assert.equal(fraction, 0.5);
  });

  it("falls back to the parsed 9:00–17:00 default when no scheduler is set", () => {
    const parsed = parseCampaignSchedule({}, defaults);
    assert.equal(parsed.startHour, 9);
    assert.equal(parsed.endHour, 17);
    const rows = rollupClientVolume(
      [{ clientId: 1, clientName: "Parlay", sent: 405, schedule: parsed }],
      noonTue,
      CHICAGO,
    );
    // 9–17 at noon is 3/8; 405 / 0.375 = 1080
    assert.equal(rows[0].projected, 1080);
    assert.equal(flagUnderVolume(rows).length, 0);
  });

  it("skips a client whose window has not started by noon", () => {
    const rows = rollupClientVolume(
      [
        {
          clientId: 1,
          clientName: "Late start",
          sent: 0,
          schedule: schedule({ startHour: 13, endHour: 18 }),
        },
      ],
      noonTue,
      CHICAGO,
    );
    assert.deepEqual(rows, []);
  });

  it("does not bleed another client's volume when names collide", () => {
    const rows = rollupClientVolume(
      [
        {
          clientId: 999,
          clientName: "Bolder Cyber Partners",
          sent: 50,
          schedule: schedule(),
        },
        {
          clientId: 542838,
          clientName: "Bolder Cyber Partners",
          sent: 400,
          schedule: schedule(),
        },
      ],
      noonTue,
      CHICAGO,
    );
    const bcp = rows.find((row) => row.clientId === 542838);
    const other = rows.find((row) => row.clientId === 999);
    assert.equal(bcp?.projected, 1200);
    assert.equal(other?.projected, 150);
  });
});

describe("send-volume skip and schedule window", () => {
  it("only resolves weekday noon (and a short grace), never Sat/Sun", () => {
    assert.deepEqual(DEFAULT_VOLUME_WEEKDAYS, [1, 2, 3, 4, 5]);
    const tue = resolveVolumeSlot(noonTue, CHICAGO);
    assert.equal(tue?.day, "2026-09-01");
    assert.equal(tue?.hour, 12);
    assert.equal(resolveVolumeSlot(friday1210, CHICAGO)?.day, "2026-08-28");
    assert.equal(resolveVolumeSlot(noonSat, CHICAGO), null);
    assert.equal(resolveVolumeSlot(noonSun, CHICAGO), null);
    // Saturday noon is not a Friday catch-up
    assert.equal(
      resolveVolumeSlot(noonSat, CHICAGO, [1, 2, 3, 4, 5], 12, 24 * 60),
      null,
    );
    // 3pm weekday is outside the grace window
    assert.equal(resolveVolumeSlot(new Date("2026-09-01T20:00:00.000Z"), CHICAGO), null);
  });

  it("treats noise and pulse-excluded leftovers as muted", () => {
    assert.equal(isVolumeSkippedCampaign({ name: "Canary shell" }), true);
    assert.equal(isVolumeSkippedCampaign({ name: "Positive", id: 3628943 }), true);
    assert.equal(
      isVolumeSkippedCampaign({ name: "BCP Healthcare Under-1k (No Team)", id: 100 }),
      false,
    );
  });
});

describe("send-volume Slack copy", () => {
  it("lists every active client on one line and flags under 1,080 projected", () => {
    const text = formatMiddayReport(
      [
        volumeRow({
          clientId: 548609,
          clientName: "Vasco Warranty",
          sent: 200,
          projected: 600,
        }),
        volumeRow({
          clientId: 10,
          clientName: "TechEvolution",
          sent: 400,
          projected: 1200,
        }),
      ],
      "2026-09-01",
    );
    assert.match(text ?? "", /\*Midday — Tue 9\/1 12:00pm\*/);
    assert.match(
      text ?? "",
      /• \*Vasco Warranty\* `#548609` — 200 sent → 600 proj · \*under\*/,
    );
    assert.match(
      text ?? "",
      /• \*TechEvolution\* `#10` — 400 sent → 1,200 proj · on track/,
    );
  });

  it("posts nothing when there are no active clients", () => {
    assert.equal(formatMiddayReport([], "2026-09-01"), null);
    assert.equal(formatEodReport([], "2026-09-01"), null);
  });

  it("omits a missing Smartlead client id", () => {
    const text = formatMiddayReport(
      [volumeRow({ clientId: null, clientName: "Unknown client", sent: 100, projected: 300 })],
      "2026-09-01",
    );
    assert.match(text ?? "", /• \*Unknown client\* — 100 sent → 300 proj · \*under\*/);
    assert.doesNotMatch(text ?? "", /`#/);
  });
});

describe("end-of-day volume", () => {
  it("compares sends to 1,200 and flags <7 days of email left", () => {
    assert.equal(emailDaysLeft(8400), 7);
    assert.equal(needsEmailTopUp(6.9), true);
    assert.equal(needsEmailTopUp(7), false);
    const rows = rollupClientEod([
      {
        clientId: 1,
        clientName: "Goliath",
        sent: 1180,
        remaining: 20000,
        schedule: schedule(),
      },
      {
        clientId: 2,
        clientName: "Vasco Warranty",
        sent: 720,
        remaining: 5000,
        schedule: schedule(),
      },
    ]);
    const goliath = rows.find((row) => row.clientId === 1);
    const vasco = rows.find((row) => row.clientId === 2);
    assert.equal(goliath?.under, false);
    assert.equal(goliath?.needsTopUp, false);
    assert.equal(vasco?.under, true);
    assert.ok(vasco?.daysLeft != null && vasco.daysLeft < 7);
    assert.equal(vasco?.needsTopUp, true);

    const text = formatEodReport(rows, "2026-09-01");
    assert.match(text ?? "", /\*EOD — Tue 9\/1\*/);
    assert.match(text ?? "", /• \*Goliath\* `#1` — 1,180 \/ 1,200/);
    assert.match(
      text ?? "",
      /• \*Vasco Warranty\* `#2` — 720 \/ 1,200 · \*under\* · \*~4\.2d left, needs top-up\*/,
    );
  });

  it("only resolves weekday 5–6pm CT, never Sat/Sun or later catch-up", () => {
    const eodTue = new Date("2026-09-01T22:30:00.000Z"); // 5:30pm CT
    const eodSat = new Date("2026-09-05T22:30:00.000Z");
    const lateTue = new Date("2026-09-02T00:10:00.000Z"); // 7:10pm CT
    assert.equal(resolveEodSlot(eodTue, CHICAGO)?.day, "2026-09-01");
    assert.equal(resolveEodSlot(eodSat, CHICAGO), null);
    assert.equal(resolveEodSlot(lateTue, CHICAGO), null);
    assert.equal(resolveVolumeSlot(eodTue, CHICAGO), null);
  });
});
