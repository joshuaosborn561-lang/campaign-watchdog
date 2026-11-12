import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OWNER_CATALOG,
  catalogClientRecords,
  mergeClientRecords,
  ownerByLegacyClientId,
  ownerBySlug,
  sgOwnerSlugs,
} from "./owners.js";
import { clientDisplayName } from "../clients/smartlead.js";

describe("owner catalog", () => {
  it("maps every slug to the legacy Smartlead client id from the deleted spaces", () => {
    const expected: Record<string, number | null> = {
      salesglider: 345263,
      parlay: 418274,
      culture_fits: 418275,
      techevo: 521881,
      bcp: 542838,
      peterson: 548610,
      goliath: 548611,
      emcor: 574020,
      insight: 582890,
      powergryd: 592842,
      vector: 597119,
      nutter: 566991,
      bpltg: 602897,
      nexus: 607522,
      virtual_pulsar: 607625,
      deep_roots: 597783,
      vasco: 548609,
      ciotola: null,
    };
    for (const [slug, id] of Object.entries(expected)) {
      assert.equal(ownerBySlug(slug)?.legacyClientId, id, slug);
    }
  });

  it("legacy ids are unique, so an id maps back to exactly one owner", () => {
    const ids = OWNER_CATALOG.map((e) => e.legacyClientId).filter((id) => id != null);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ownerByLegacyClientId(542838)?.slug, "bcp");
  });

  it("accepts the live tag spelling deeproots as deep_roots", () => {
    assert.equal(ownerBySlug("deeproots")?.slug, "deep_roots");
    assert.deepEqual(sgOwnerSlugs([{ tag_name: "sg-owner:deeproots" }]), ["deep_roots"]);
  });

  it("marks ciotola inactive and everyone else active", () => {
    assert.equal(ownerBySlug("ciotola")?.active, false);
    assert.equal(OWNER_CATALOG.filter((e) => !e.active).map((e) => e.slug).join(), "ciotola");
  });

  it("reads sg-owner slugs from Smartlead tag objects and ignores other tags", () => {
    assert.deepEqual(
      sgOwnerSlugs([
        { tag_id: 1, tag_name: "sg-owner:BCP", tag_color: "#fff" },
        { tag_id: 2, tag_name: "Healthcare" },
        { tag_id: 3, tag_name: "sg-owner:bcp" },
      ]),
      ["bcp"],
    );
    assert.deepEqual(sgOwnerSlugs([{ tag_name: "sg-owner:bcp" }, { tag_name: "sg-owner:parlay" }]).sort(), [
      "bcp",
      "parlay",
    ]);
    assert.deepEqual(sgOwnerSlugs(undefined), []);
    assert.deepEqual(sgOwnerSlugs([{ tag_name: "sg-owner:" }, null, 5]), []);
  });

  it("catalog client records keep today's clientDisplayName output", () => {
    const records = new Map(catalogClientRecords().map((r) => [r.id, r]));
    assert.equal(clientDisplayName(records.get(542838)), "Bolder Cyber Partners (Mike Trpkosh)");
    assert.equal(clientDisplayName(records.get(345263)), "SalesGlider");
    assert.equal(clientDisplayName(records.get(597119)), "Vector Energy Group");
    assert.equal(records.size, 17);
  });

  it("live /client rows (if spaces ever return) override catalog rows by id", () => {
    const merged = mergeClientRecords(catalogClientRecords(), [
      { id: 542838, name: "New BCP name" },
      { id: 1, name: "Brand new" },
    ]);
    const byId = new Map(merged.map((r) => [r.id, r]));
    assert.equal(byId.get(542838)?.name, "New BCP name");
    assert.equal(byId.get(1)?.name, "Brand new");
    assert.equal(byId.get(418274)?.logo, "Parlay Tech");
  });
});
