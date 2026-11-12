/**
 * Owner catalog. Smartlead client spaces were deleted on 2026-11-11: every
 * campaign and mailbox now has `client_id = null` and `GET /client` returns [].
 * Campaign ownership lives only in a unique `sg-owner:<slug>` campaign tag
 * (read with `include_tags=true`).
 *
 * Every consumer here keys on the numeric Smartlead client id it saw before
 * the deletion, so a tag resolves to that slug's legacy id. Slugs that never
 * had their own space keep `legacyClientId: null` and stay id-less (send-ops
 * skip them as "no client", exactly as before).
 *
 * `name` is the display name the watchdog showed (the `_meta.client_registry`
 * name / the Smartlead client `logo`). `smartleadName` / `smartleadLogo` copy
 * the deleted Smartlead client records (spaces backup, 2026-11-11) so
 * `clientDisplayName()` output for catalog records is unchanged.
 *
 * Slugs mirror deliverabilitywizard `src/lib/ownership.ts` OWNER_CATALOG.
 */

import type { SmartleadClientRecord } from "../clients/smartlead.js";

export const SG_OWNER_TAG_PREFIX = "sg-owner:";

export interface OwnerCatalogEntry {
  slug: string;
  /** Other spellings of the slug accepted on tags (e.g. deep_roots / deeproots). */
  aliases?: string[];
  /** Smartlead client id from the deleted space; null = never had its own space. */
  legacyClientId: number | null;
  /** Display name (registry name). */
  name: string;
  smartleadName?: string;
  smartleadLogo?: string | null;
  /**
   * Inactive owners still resolve to their slug / name for reporting, but
   * send-ops (bounce auto-resume, paused sweep) never START their campaigns.
   */
  active: boolean;
}

export const OWNER_CATALOG: readonly OwnerCatalogEntry[] = [
  { slug: "salesglider", legacyClientId: 345263, name: "SalesGlider", smartleadName: "SalesGlider", smartleadLogo: "SalesGlider", active: true },
  { slug: "parlay", legacyClientId: 418274, name: "Parlay Tech", smartleadName: "Randy Haba", smartleadLogo: "Parlay Tech", active: true },
  { slug: "culture_fits", legacyClientId: 418275, name: "Culture Fits", smartleadName: "TJ Johnson", smartleadLogo: "Culture Fits", active: true },
  { slug: "techevo", legacyClientId: 521881, name: "TechEvolution", smartleadName: "Corey Tapper", smartleadLogo: "TechEvolution", active: true },
  { slug: "bcp", legacyClientId: 542838, name: "Bolder Cyber Partners", smartleadName: "Mike Trpkosh", smartleadLogo: "Bolder Cyber Partners", active: true },
  { slug: "peterson", legacyClientId: 548610, name: "Roofs by Peterson", smartleadName: "Kyle Peterson", smartleadLogo: "Roofs by Peterson", active: true },
  { slug: "goliath", legacyClientId: 548611, name: "Goliath Cybersecurity", smartleadName: "Dave Ackley", smartleadLogo: "Goliath Cybersecurity", active: true },
  { slug: "nutter", legacyClientId: 566991, name: "Nutter Group", smartleadName: "Roger Nutter", smartleadLogo: "Nutter Group", active: true },
  { slug: "emcor", legacyClientId: 574020, name: "Emcor", smartleadName: "Myles McIntosh", smartleadLogo: "Emcor", active: true },
  { slug: "insight", legacyClientId: 582890, name: "Insight", smartleadName: "Insight", smartleadLogo: "Insight", active: true },
  { slug: "powergryd", legacyClientId: 592842, name: "PowerGRYD", smartleadName: "PowerGryd", smartleadLogo: "PowerGRYD", active: true },
  { slug: "vector", legacyClientId: 597119, name: "Vector Energy Group", smartleadName: "Vector Energy Group", smartleadLogo: null, active: true },
  { slug: "bpltg", legacyClientId: 602897, name: "BPLTG", smartleadName: "BPLTG", smartleadLogo: "BPLTG", active: true },
  { slug: "nexus", legacyClientId: 607522, name: "Nexus Dynamics Group", smartleadName: "Nexus Dynamics Group", smartleadLogo: "Nexus Dynamics Group", active: true },
  { slug: "virtual_pulsar", legacyClientId: 607625, name: "Virtual Pulsar", smartleadName: "Virtual Pulsar", smartleadLogo: "Virtual Pulsar", active: true },
  { slug: "deep_roots", aliases: ["deeproots"], legacyClientId: 597783, name: "Deep Roots Capital", active: true },
  // Retired: already excluded by id 548609 in the paused-sweep / leads skip lists.
  { slug: "vasco", legacyClientId: 548609, name: "Vasco Warranty", active: true },
  // Inactive. Its campaigns lived inside the SalesGlider space; it never had its own id.
  { slug: "ciotola", legacyClientId: null, name: "Ciotola", active: false },
  // Tagged owners that never had a Smartlead space: no numeric id.
  { slug: "cornerstone", legacyClientId: null, name: "Cornerstone Earthworks", active: true },
  { slug: "nieto", legacyClientId: null, name: "Nieto", active: true },
  { slug: "msrs", legacyClientId: null, name: "MSRS", active: true },
  { slug: "positive", legacyClientId: null, name: "Positive", active: true },
];

const BY_SLUG = new Map<string, OwnerCatalogEntry>();
for (const entry of OWNER_CATALOG) {
  BY_SLUG.set(entry.slug, entry);
  for (const alias of entry.aliases ?? []) BY_SLUG.set(alias, entry);
}

const BY_LEGACY_ID = new Map<number, OwnerCatalogEntry>();
for (const entry of OWNER_CATALOG) {
  if (entry.legacyClientId != null && !BY_LEGACY_ID.has(entry.legacyClientId)) {
    BY_LEGACY_ID.set(entry.legacyClientId, entry);
  }
}

export function ownerBySlug(slug: string | null | undefined): OwnerCatalogEntry | undefined {
  return slug ? BY_SLUG.get(slug.trim().toLowerCase()) : undefined;
}

export function ownerByLegacyClientId(id: number | null | undefined): OwnerCatalogEntry | undefined {
  return id == null ? undefined : BY_LEGACY_ID.get(id);
}

type TagLike = { tag_name?: unknown; name?: unknown } | string | null | undefined;

function tagName(tag: TagLike): string {
  if (typeof tag === "string") return tag;
  if (!tag || typeof tag !== "object") return "";
  const value = tag.tag_name ?? tag.name;
  return typeof value === "string" ? value : "";
}

/** Canonical slug: catalog aliases collapse onto one slug. */
function canonicalSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  return BY_SLUG.get(slug)?.slug ?? slug;
}

/** Distinct canonical sg-owner slugs on a tag list. */
export function sgOwnerSlugs(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const tag of tags as TagLike[]) {
    const name = tagName(tag).trim();
    if (!name.toLowerCase().startsWith(SG_OWNER_TAG_PREFIX)) continue;
    const slug = name.slice(SG_OWNER_TAG_PREFIX.length).trim();
    if (slug) out.add(canonicalSlug(slug));
  }
  return [...out];
}

/** Catalog records in the shape Smartlead `GET /client` used to return. */
export function catalogClientRecords(): SmartleadClientRecord[] {
  const out: SmartleadClientRecord[] = [];
  for (const entry of BY_LEGACY_ID.values()) {
    out.push({
      id: entry.legacyClientId as number,
      name: entry.smartleadName ?? entry.name,
      logo: entry.smartleadName ? (entry.smartleadLogo ?? null) : null,
    });
  }
  return out;
}

/** Catalog first; any live `/client` rows (if spaces ever come back) override by id. */
export function mergeClientRecords(
  catalog: SmartleadClientRecord[],
  live: SmartleadClientRecord[],
): SmartleadClientRecord[] {
  const byId = new Map<number, SmartleadClientRecord>();
  for (const row of catalog) byId.set(row.id, row);
  for (const row of live) {
    if (row && typeof row.id === "number" && Number.isFinite(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}
