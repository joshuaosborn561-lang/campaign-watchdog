import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAUSE_WRITE = /updateCampaignStatus\s*\(\s*[^)]*?["'`]PAUSED["'`]/;
const STOP_WRITE = /updateCampaignStatus\s*\(\s*[^)]*?["'`]STOPPED["'`]/;
const RAW_STATUS_BODY = /body:\s*\{[^}]*status:\s*["'`](?:PAUSED|STOPPED)["'`]/;
const STATUS_PATH_POST = /campaigns\/\$\{[^}]+}\/status/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("Watchdog never pauses or stops a campaign", () => {
  it("has no PAUSED or STOPPED Smartlead status write outside the client guard", () => {
    const files = walkTs(SRC_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file);
      const source = readFileSync(file, "utf8");
      if (PAUSE_WRITE.test(source)) violations.push(`${rel}: updateCampaignStatus PAUSED`);
      if (STOP_WRITE.test(source)) violations.push(`${rel}: updateCampaignStatus STOPPED`);
      if (RAW_STATUS_BODY.test(source)) violations.push(`${rel}: raw status body PAUSED/STOPPED`);
      if (rel !== path.join("clients", "smartlead.ts") && STATUS_PATH_POST.test(source)) {
        violations.push(`${rel}: campaigns/{id}/status write outside Smartlead client`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it("keeps the Smartlead client guard on PAUSED and STOPPED", () => {
    const source = readFileSync(path.join(SRC_ROOT, "clients", "smartlead.ts"), "utf8");
    assert.match(source, /assertAllowedCampaignStatus/);
    assert.match(source, /FORBIDDEN_CAMPAIGN_STATUSES/);
    assert.match(source, /refused Smartlead status change/);
  });
});
