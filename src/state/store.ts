import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CampaignSnapshot {
  status: string;
  notifiedThresholds: number[];
  lastCompletionPct?: number;
  lastAutobounceAlertAt?: string;
  lastSendingAlertDay?: string;
  seen: boolean;
}

export interface HeyReachSnapshot {
  status: string;
  seen: boolean;
  lastRunwayDays?: number | null;
  lastPending?: number;
  lastRemaining?: number;
  notifiedUnder7?: boolean;
  notifiedPendingDry?: boolean;
}

/** A Smartlead post that fired during a POD swap and still needs to run. */
export interface DeferredSmartleadJob {
  kind: "pulse" | "midday" | "eod";
  slot: string;
  firedAt: string;
}

export interface WatchdogState {
  campaigns: Record<string, CampaignSnapshot>;
  heyreachCampaigns?: Record<string, HeyReachSnapshot>;
  lastDigestDay?: string;
  lastPulseSlot?: string;
  lastVolumeDay?: string;
  lastEodDay?: string;
  /** Pulse / midday / EOD held while the wizard POD swap owns Smartlead. */
  deferredJobs?: DeferredSmartleadJob[];
  slack?: {
    access_token?: string;
    refresh_token?: string;
  };
}

const EMPTY: WatchdogState = { campaigns: {} };

export class StateStore {
  private state: WatchdogState = { campaigns: {} };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as WatchdogState;
      this.state = {
        campaigns: parsed.campaigns ?? {},
        heyreachCampaigns: parsed.heyreachCampaigns ?? {},
        lastDigestDay: parsed.lastDigestDay,
        lastPulseSlot: parsed.lastPulseSlot,
        lastVolumeDay: parsed.lastVolumeDay,
        lastEodDay: parsed.lastEodDay,
        deferredJobs: Array.isArray(parsed.deferredJobs) ? parsed.deferredJobs.map((job) => ({ ...job })) : [],
        slack: parsed.slack,
      };
    } catch {
      this.state = { ...EMPTY, campaigns: {} };
    }
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  snapshot(campaignId: number): CampaignSnapshot {
    const key = String(campaignId);
    const existing = this.state.campaigns[key];
    if (existing) return existing;
    const created: CampaignSnapshot = {
      status: "",
      notifiedThresholds: [],
      seen: false,
    };
    this.state.campaigns[key] = created;
    return created;
  }

  put(campaignId: number, snapshot: CampaignSnapshot): void {
    this.state.campaigns[String(campaignId)] = snapshot;
  }

  heyreachKey(workspaceId: string, campaignId: number): string {
    return `${workspaceId}:${campaignId}`;
  }

  heyreachSnapshot(workspaceId: string, campaignId: number): HeyReachSnapshot {
    const key = this.heyreachKey(workspaceId, campaignId);
    const store = (this.state.heyreachCampaigns ??= {});
    const existing = store[key];
    if (existing) return existing;
    const created: HeyReachSnapshot = { status: "", seen: false };
    store[key] = created;
    return created;
  }

  putHeyreach(workspaceId: string, campaignId: number, snapshot: HeyReachSnapshot): void {
    const store = (this.state.heyreachCampaigns ??= {});
    store[this.heyreachKey(workspaceId, campaignId)] = snapshot;
  }

  slackTokens(): { access_token?: string; refresh_token?: string } | undefined {
    return this.state.slack;
  }

  setSlackTokens(tokens: { access_token?: string; refresh_token?: string }): void {
    this.state.slack = tokens;
  }

  lastDigestDay(): string | undefined {
    return this.state.lastDigestDay;
  }

  setLastDigestDay(day: string): void {
    this.state.lastDigestDay = day;
  }

  lastPulseSlot(): string | undefined {
    return this.state.lastPulseSlot;
  }

  setLastPulseSlot(slot: string): void {
    this.state.lastPulseSlot = slot;
  }

  lastVolumeDay(): string | undefined {
    return this.state.lastVolumeDay;
  }

  setLastVolumeDay(day: string): void {
    this.state.lastVolumeDay = day;
  }

  lastEodDay(): string | undefined {
    return this.state.lastEodDay;
  }

  setLastEodDay(day: string): void {
    this.state.lastEodDay = day;
  }

  deferredJobs(): DeferredSmartleadJob[] {
    return [...(this.state.deferredJobs ?? [])].sort((a, b) => a.firedAt.localeCompare(b.firedAt));
  }

  /** Keep the earliest fire for a slot. A second cron tick must not move it. */
  deferJob(job: DeferredSmartleadJob): void {
    const jobs = this.state.deferredJobs ?? [];
    if (jobs.some((row) => row.kind === job.kind && row.slot === job.slot)) return;
    const next = [...jobs, job].sort((a, b) => a.firedAt.localeCompare(b.firedAt)).slice(-12);
    this.state.deferredJobs = next;
  }

  removeDeferredJob(kind: DeferredSmartleadJob["kind"], slot: string): void {
    this.state.deferredJobs = (this.state.deferredJobs ?? []).filter(
      (row) => !(row.kind === kind && row.slot === slot),
    );
  }
}
