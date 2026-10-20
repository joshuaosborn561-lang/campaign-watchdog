import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

describe("Slack user mentions", () => {
  it("only slackMention in pulse.ts builds <@USER> pings", () => {
    const files = walkTs(SRC_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file);
      const source = readFileSync(file, "utf8");
      if (rel === path.join("lib", "pulse.ts")) {
        assert.match(source, /function slackMention/);
        assert.match(source, /<@\$\{id\}>/);
        continue;
      }
      if (source.includes("<@")) {
        violations.push(`${rel}: unexpected Slack user mention markup`);
      }
    }
    assert.deepEqual(violations, []);
  });
});
