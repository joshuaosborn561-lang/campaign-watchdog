import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SwapQuietGate,
  inSwapQuietWindow,
  interpretSwapSignal,
  parseClockMinutes,
  type SwapQuietSettings,
} from "./swap-quiet.js";

const monday1005 = new Date("2026-11-09T16:05:00.000Z");
const monday0559 = new Date("2026-11-09T11:59:00.000Z");
const monday0600 = new Date("2026-11-09T12:00:00.000Z");
const monday1215 = new Date("2026-11-09T18:15:00.000Z");
const tuesday1005 = new Date("2026-09-01T15:05:00.000Z");

function settings(partial: Partial<SwapQuietSettings> = {}): SwapQuietSettings {
  return {
    source: "auto",
    signalUrl: "",
    signalToken: "",
    signalTable: "",
    signalSchema: "public",
    signalRowId: "",
    signalTimeoutMs: 1000,
    signalMaxAgeMinutes: 240,
    weekdays: [1],
    startMinutes: 6 * 60,
    endMinutes: 12 * 60,
    timeZone: "America/Chicago",
    ...partial,
  };
}

describe("swap quiet window", () => {
  it("parses HH:MM and treats Monday 06:00-12:00 Chicago as the fallback", () => {
    assert.equal(parseClockMinutes("06:00", "SWAP_QUIET_START", 0), 360);
    assert.equal(parseClockMinutes("6:30", "SWAP_QUIET_START", 0), 390);
    const window = settings();
    assert.equal(inSwapQuietWindow(monday0559, window), false);
    assert.equal(inSwapQuietWindow(monday0600, window), true);
    assert.equal(inSwapQuietWindow(monday1005, window), true);
    assert.equal(inSwapQuietWindow(monday1215, window), false);
    assert.equal(inSwapQuietWindow(tuesday1005, window), false);
  });
});

describe("interpretSwapSignal", () => {
  it("treats an open started_at as in progress and a past finished_at as done", () => {
    const open = interpretSwapSignal(
      { swap_in_progress: true, started_at: "2026-11-09T14:00:00.000Z", finished_at: null },
      monday1005,
      4 * 60 * 60 * 1000,
    );
    assert.equal(open.known, true);
    assert.equal(open.inProgress, true);

    const done = interpretSwapSignal(
      {
        in_progress: true,
        started_at: "2026-11-09T14:00:00.000Z",
        finished_at: "2026-11-09T15:40:00.000Z",
      },
      monday1005,
      4 * 60 * 60 * 1000,
    );
    assert.equal(done.known, true);
    assert.equal(done.inProgress, false);
  });

  it("picks the newest row and ignores a stuck flag older than the max age", () => {
    const newest = interpretSwapSignal(
      [
        { started_at: "2026-11-02T14:00:00.000Z", finished_at: null },
        { started_at: "2026-11-09T15:00:00.000Z", status: "finished" },
      ],
      monday1005,
      4 * 60 * 60 * 1000,
    );
    assert.equal(newest.known, true);
    assert.equal(newest.inProgress, false);

    const stale = interpretSwapSignal(
      { started_at: "2026-11-09T10:00:00.000Z" },
      monday1005,
      4 * 60 * 60 * 1000,
    );
    assert.equal(stale.known, false);
    assert.equal(stale.inProgress, false);
  });
});

describe("SwapQuietGate", () => {
  it("stays quiet on Monday morning when no signal is configured", async () => {
    const gate = new SwapQuietGate(settings(), { cacheMs: 0 });
    const morning = await gate.current(monday1005);
    assert.equal(morning.quiet, true);
    assert.equal(morning.source, "window");
    const afternoon = await gate.current(monday1215);
    assert.equal(afternoon.quiet, false);
    const tuesday = await gate.current(tuesday1005);
    assert.equal(tuesday.quiet, false);
  });

  it("lets a live finished signal resume inside the Monday window", async () => {
    const gate = new SwapQuietGate(settings({ signalUrl: "https://wizard.example/swap" }), {
      cacheMs: 0,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            in_progress: false,
            started_at: "2026-11-09T14:00:00.000Z",
            finished_at: "2026-11-09T15:50:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });
    const decision = await gate.current(monday1005);
    assert.equal(decision.quiet, false);
    assert.equal(decision.source, "http");
  });

  it("stays quiet outside the window when the signal says the swap is running", async () => {
    const gate = new SwapQuietGate(settings({ signalUrl: "https://wizard.example/swap" }), {
      cacheMs: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ data: { status: "in_progress", started_at: "2026-09-01T14:00:00.000Z" } }), {
          status: 200,
        })) as typeof fetch,
    });
    const decision = await gate.current(tuesday1005);
    assert.equal(decision.quiet, true);
    assert.equal(decision.source, "http");
  });

  it("falls back to the window when the signal endpoint fails", async () => {
    const gate = new SwapQuietGate(settings({ source: "http", signalUrl: "https://wizard.example/swap" }), {
      cacheMs: 0,
      fetch: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    const morning = await gate.current(monday1005);
    assert.equal(morning.quiet, true);
    assert.equal(morning.source, "window");
    const tuesday = await gate.current(tuesday1005);
    assert.equal(tuesday.quiet, false);
  });

  it("reads a Supabase row when that source is selected", async () => {
    const gate = new SwapQuietGate(
      settings({ source: "supabase", signalTable: "wizard_swap_status" }),
      {
        cacheMs: 0,
        supabase: {
          enabled: () => true,
          fetchSwapSignal: async (table) => {
            assert.equal(table, "wizard_swap_status");
            return [{ started_at: "2026-11-09T14:10:00.000Z", finished_at: null, in_progress: true }];
          },
        },
      },
    );
    const decision = await gate.current(monday1005);
    assert.equal(decision.quiet, true);
    assert.equal(decision.source, "supabase");
  });

  it("can be turned off", async () => {
    const gate = new SwapQuietGate(settings({ source: "off", signalUrl: "https://wizard.example/swap" }), {
      cacheMs: 0,
      fetch: (() => {
        throw new Error("should not fetch");
      }) as typeof fetch,
    });
    const decision = await gate.current(monday1005);
    assert.equal(decision.quiet, false);
    assert.equal(decision.source, "off");
  });
});
