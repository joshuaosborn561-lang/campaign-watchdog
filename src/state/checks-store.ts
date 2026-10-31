import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DoubleSigEntry, LeadAlertEntry } from "../lib/leads-check.js";
import type { DroughtAlertEntry } from "../lib/meeting-drought.js";

export interface ChecksState {
  /** Paused-sweep memory: how many times we restarted a campaign, and one-time notices. */
  sweep: {
    restartCounts: Record<string, number>;
    unstartableNotified: Record<string, string>;
  };
  leadAlerts: Record<string, LeadAlertEntry>;
  doubleSigs: Record<string, DoubleSigEntry>;
  droughtAlerts: Record<string, DroughtAlertEntry>;
  /** Clients we already said "no booking source" about. */
  droughtGapsReported: Record<string, string>;
}

export function emptyChecksState(): ChecksState {
  return {
    sweep: { restartCounts: {}, unstartableNotified: {} },
    leadAlerts: {},
    doubleSigs: {},
    droughtAlerts: {},
    droughtGapsReported: {},
  };
}

/**
 * Separate state file from the 15-minute watch (`watchdog-state.json`) so the checks
 * and the watch never overwrite each other's memory.
 */
export class ChecksStore {
  state: ChecksState = emptyChecksState();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ChecksState>;
      const empty = emptyChecksState();
      this.state = {
        sweep: {
          restartCounts: parsed.sweep?.restartCounts ?? empty.sweep.restartCounts,
          unstartableNotified: parsed.sweep?.unstartableNotified ?? empty.sweep.unstartableNotified,
        },
        leadAlerts: parsed.leadAlerts ?? empty.leadAlerts,
        doubleSigs: parsed.doubleSigs ?? empty.doubleSigs,
        droughtAlerts: parsed.droughtAlerts ?? empty.droughtAlerts,
        droughtGapsReported: parsed.droughtGapsReported ?? empty.droughtGapsReported,
      };
    } catch {
      this.state = emptyChecksState();
    }
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  dir(): string {
    return path.dirname(this.filePath);
  }
}
