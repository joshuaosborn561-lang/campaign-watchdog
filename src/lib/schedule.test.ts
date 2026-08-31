import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  gapLimitedSendsPerInbox,
  parseCampaignSchedule,
  windowMinutes,
} from "./schedule.js";

describe("schedule", () => {
  it("reads Smartlead scheduler_cron_value and daily cap", () => {
    const schedule = parseCampaignSchedule(
      {
        scheduler_cron_value: {
          tz: "America/New_York",
          days: [1, 2, 3, 4, 5],
          startHour: "09:00",
          endHour: "17:00",
        },
        min_time_btwn_emails: 10,
        max_new_leads_per_day: 15,
      },
      { timeZone: "UTC", gapMinutes: 10 },
    );
    assert.equal(schedule.timeZone, "America/New_York");
    assert.equal(schedule.maxLeadsPerDay, 15);
    assert.equal(windowMinutes(schedule), 480);
    assert.equal(gapLimitedSendsPerInbox(schedule, 30), 30);
  });

  it("ignores dummy Smartlead sending_limit values", () => {
    const schedule = parseCampaignSchedule(
      { max_leads_per_day: 10000, sending_limit: 3000 },
      { timeZone: "America/New_York", gapMinutes: 10 },
    );
    assert.equal(schedule.maxLeadsPerDay, null);
  });

  it("caps one inbox at window / 10 minutes", () => {
    const schedule = parseCampaignSchedule(
      { start_hour: "16:00", end_hour: "17:00", min_time_btw_emails: 10 },
      { timeZone: "America/New_York", gapMinutes: 10 },
    );
    assert.equal(gapLimitedSendsPerInbox(schedule, 30), 6);
  });
});
