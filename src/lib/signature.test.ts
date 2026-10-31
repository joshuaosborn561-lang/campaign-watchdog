import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSignature } from "./signature.js";

describe("analyzeSignature", () => {
  it("flags a copy sign-off followed by the mailbox signature", () => {
    const html =
      "<div>Hi Sam,</div><div>Still worth 20 minutes?</div><div>— Joshua Osborn</div><div>Joshua Osborn</div><div>SalesGlider</div>";
    assert.equal(analyzeSignature(html).double, true);
  });

  it("does not flag a single signature", () => {
    const html =
      "<div>Hi Sam,</div><div>Worth a quick chat this week about your pipeline?</div><div>Joshua Osborn</div><div>SalesGlider</div>";
    assert.equal(analyzeSignature(html).double, false);
  });

  it("does not treat the greeting as a signature block", () => {
    const html =
      "<div>Roger,</div><div>Quick question about hiring a board advisor, are you open to it?</div><div>Best,</div><div>Josh Osborn</div>";
    assert.equal(analyzeSignature(html).double, false);
  });

  it("ignores quoted replies", () => {
    const html =
      "<div>Thanks for the note!</div><div>Josh</div><blockquote><div>Joshua Osborn</div><div>SalesGlider</div></blockquote>";
    assert.equal(analyzeSignature(html).double, false);
  });

  it("handles empty bodies", () => {
    assert.equal(analyzeSignature("").double, false);
    assert.equal(analyzeSignature(null).double, false);
  });
});
