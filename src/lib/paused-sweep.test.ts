import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PAUSED_SWEEP_EXCLUDE_CLIENT_IDS,
  DEFAULT_PAUSED_SWEEP_EXCLUDE_IDS,
  DEFAULT_PAUSED_SWEEP_HOLD_IDS,
  pausedSweepSkipReason,
  type PausedSweepCandidate,
} from "./paused-sweep.js";
import { parseCheckMode } from "./check-mode.js";

const rules = {
  holdIds: DEFAULT_PAUSED_SWEEP_HOLD_IDS,
  excludeIds: DEFAULT_PAUSED_SWEEP_EXCLUDE_IDS,
  excludeClientIds: DEFAULT_PAUSED_SWEEP_EXCLUDE_CLIENT_IDS,
};
const base: PausedSweepCandidate = {
  id: 1,
  name: "Peterson C2",
  status: "PAUSED",
  clientId: 548610,
  linkedMailboxes: 10,
  remainingLeads: 500,
};

describe("pausedSweepSkipReason", () => {
  it("starts a plain PAUSED client campaign (bounce pause or not)", () => {
    assert.equal(pausedSweepSkipReason(base, rules), null);
  });

  it("NEVER starts a STOPPED campaign, in any casing", () => {
    for (const status of ["STOPPED", "stopped", " Stopped "]) {
      assert.equal(pausedSweepSkipReason({ ...base, status }, rules), "stopped");
    }
  });

  it("only PAUSED is startable (ACTIVE, COMPLETED, DRAFTED, empty are not)", () => {
    for (const status of ["ACTIVE", "COMPLETED", "DRAFTED", "", undefined]) {
      assert.equal(pausedSweepSkipReason({ ...base, status }, rules), "not paused");
    }
  });

  it("holds the five Goliath campaigns", () => {
    for (const id of DEFAULT_PAUSED_SWEEP_HOLD_IDS) {
      assert.equal(pausedSweepSkipReason({ ...base, id }, rules), "held on purpose");
    }
  });

  it("skips Gabe's call campaigns, shells, retired client, no-client, no senders, no leads", () => {
    assert.equal(pausedSweepSkipReason({ ...base, id: 4085158 }, rules), "excluded id");
    assert.equal(
      pausedSweepSkipReason({ ...base, name: "Canary Shell test" }, rules),
      "noise",
    );
    assert.equal(pausedSweepSkipReason({ ...base, clientId: 548609 }, rules), "excluded client");
    assert.equal(pausedSweepSkipReason({ ...base, clientId: null }, rules), "no client");
    assert.equal(pausedSweepSkipReason({ ...base, linkedMailboxes: 0 }, rules), "no senders");
    assert.equal(pausedSweepSkipReason({ ...base, remainingLeads: 0 }, rules), "no leads");
  });
});

describe("parseCheckMode", () => {
  it("defaults to the fallback and treats junk as dry-run", () => {
    assert.equal(parseCheckMode(undefined, "dry-run"), "dry-run");
    assert.equal(parseCheckMode("", "live"), "live");
    assert.equal(parseCheckMode("banana", "live"), "dry-run");
  });
  it("parses live / off / dry-run", () => {
    assert.equal(parseCheckMode("LIVE", "dry-run"), "live");
    assert.equal(parseCheckMode("off", "dry-run"), "off");
    assert.equal(parseCheckMode("dry-run", "live"), "dry-run");
  });
});
