import {
  clientDisplayName,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { CampaignNameRow } from "../clients/supabase.js";
import { ownerBySlug, sgOwnerSlugs } from "./owners.js";
import { asNumber, unwrap } from "./parse.js";

export interface ResolvedClient {
  clientId: number | null;
  clientName: string;
  /** sg-owner slug, set only when the owner came from the campaign's sg-owner tag. */
  ownerSlug?: string;
  /** True for a catalog owner marked inactive (e.g. ciotola). Send-ops never START these. */
  inactive?: boolean;
}

export type OwnerTagResult =
  | { kind: "none" }
  | { kind: "ambiguous"; slugs: string[] }
  | { kind: "owner"; slug: string };

/**
 * sg-owner tags on the list row and the campaign detail, merged.
 * Exactly one distinct slug = owner. Two or more = ambiguous (unowned).
 */
export function ownerTagOf(campaign: { tags?: unknown }, detail?: unknown): OwnerTagResult {
  const slugs = new Set<string>(sgOwnerSlugs(campaign.tags));
  const root = unwrap(detail);
  if (root) for (const slug of sgOwnerSlugs(root.tags)) slugs.add(slug);
  if (slugs.size === 0) return { kind: "none" };
  if (slugs.size > 1) return { kind: "ambiguous", slugs: [...slugs].sort() };
  return { kind: "owner", slug: [...slugs][0]! };
}

/** Smartlead client_id from a list row, campaign detail, or nested `client`. */
export function clientIdFrom(raw: unknown): number | null {
  const root = unwrap(raw);
  if (!root) return null;
  return (
    asNumber(root.client_id) ??
    asNumber(root.clientId) ??
    asNumber(unwrap(root.client)?.id) ??
    null
  );
}

export function clientGroupKey(row: {
  clientId?: number | null;
  clientName: string;
}): string {
  return row.clientId != null ? `id:${row.clientId}` : `name:${row.clientName}`;
}

/**
 * Bind a campaign to exactly one client. Order:
 *  (a) a unique `sg-owner:<slug>` tag (list row or detail) → owner catalog
 *      legacy id / name. The tag wins over everything, including a
 *      conflicting stale Supabase id. Two or more distinct sg-owner tags are
 *      ambiguous: the campaign is unowned (Unknown client), never guessed.
 *  (b) Smartlead `client_id` (list row, then detail) — null since the
 *      2026-11-11 space deletion, kept for safety.
 *  (c) campaignintelligence `smartlead_client_id`.
 *  (d) campaignintelligence `client_name` (no id).
 *  (e) Unknown client.
 * A stale campaignintelligence `client_name` must never move another
 * client's volume onto BCP (or anyone else).
 *
 * No campaign-name substring matching — untagged campaigns stay Unknown
 * unless Supabase has a client id or a name and no conflicting id.
 */
export function resolveClient(
  campaign: Pick<SmartleadCampaign, "id" | "client_id" | "tags">,
  clientsById: Map<number, SmartleadClientRecord>,
  supabaseCampaigns: Map<number, CampaignNameRow>,
  registry: Map<number, string>,
  detail?: unknown,
): ResolvedClient {
  const tag = ownerTagOf(campaign, detail);
  if (tag.kind === "ambiguous") return { clientId: null, clientName: "Unknown client" };
  if (tag.kind === "owner") {
    const entry = ownerBySlug(tag.slug);
    if (!entry) {
      // Tag for an owner this build does not know: name it, never give it an id.
      return { clientId: null, clientName: tag.slug, ownerSlug: tag.slug };
    }
    const clientId = entry.legacyClientId;
    const registryName = clientId != null ? registry.get(clientId)?.trim() : undefined;
    const resolved: ResolvedClient = {
      clientId,
      clientName: registryName || entry.name,
      ownerSlug: entry.slug,
    };
    if (!entry.active) resolved.inactive = true;
    return resolved;
  }

  const supabaseRow = supabaseCampaigns.get(campaign.id);
  const clientId =
    campaign.client_id ??
    clientIdFrom(detail) ??
    supabaseRow?.smartlead_client_id ??
    null;

  if (clientId != null) {
    const registryName = registry.get(clientId)?.trim();
    if (registryName) return { clientId, clientName: registryName };

    const smartlead = clientsById.get(clientId);
    if (smartlead) return { clientId, clientName: clientDisplayName(smartlead) };

    const supabaseName = supabaseRow?.client_name?.trim();
    const supabaseAgrees =
      supabaseRow?.smartlead_client_id == null ||
      supabaseRow.smartlead_client_id === clientId;
    if (supabaseName && supabaseAgrees) {
      return { clientId, clientName: supabaseName };
    }
    return { clientId, clientName: `Client ${clientId}` };
  }

  const supabaseName = supabaseRow?.client_name?.trim();
  if (supabaseName) return { clientId: null, clientName: supabaseName };
  return { clientId: null, clientName: "Unknown client" };
}

export function resolveClientName(
  campaign: Pick<SmartleadCampaign, "id" | "client_id" | "tags">,
  clientsById: Map<number, SmartleadClientRecord>,
  supabaseCampaigns: Map<number, CampaignNameRow>,
  registry: Map<number, string>,
  detail?: unknown,
): string {
  return resolveClient(campaign, clientsById, supabaseCampaigns, registry, detail)
    .clientName;
}
