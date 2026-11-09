import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { StateStore } from "./store.js";

describe("StateStore", () => {
  it("picks up HeyReach flag edits on the next load without a process restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "watchdog-state-"));
    const filePath = path.join(dir, "watchdog-state.json");
    const state = new StateStore(filePath);
    try {
      state.putHeyreach("techevo", 566902, {
        status: "IN_PROGRESS",
        seen: true,
        notifiedUnder7: true,
        notifiedPendingDry: true,
      });
      await state.save();

      assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedUnder7, true);
      assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedPendingDry, true);

      await writeFile(
        filePath,
        JSON.stringify(
          {
            campaigns: {},
            heyreachCampaigns: {
              "techevo:566902": {
                status: "IN_PROGRESS",
                seen: true,
                notifiedUnder7: false,
                notifiedPendingDry: false,
              },
            },
          },
          null,
          2,
        ),
      );

      await state.load();
      assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedUnder7, false);
      assert.equal(state.heyreachSnapshot("techevo", 566902).notifiedPendingDry, false);

      state.deferJob({ kind: "pulse", slot: "2026-11-09T10", firedAt: "2026-11-09T16:05:00.000Z" });
      state.deferJob({ kind: "pulse", slot: "2026-11-09T10", firedAt: "2026-11-09T16:06:00.000Z" });
      await state.save();
      const reloaded = new StateStore(filePath);
      await reloaded.load();
      assert.deepEqual(reloaded.deferredJobs(), [
        { kind: "pulse", slot: "2026-11-09T10", firedAt: "2026-11-09T16:05:00.000Z" },
      ]);
      reloaded.removeDeferredJob("pulse", "2026-11-09T10");
      await reloaded.save();
      await state.load();
      assert.deepEqual(state.deferredJobs(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
