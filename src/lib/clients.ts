import {
  clientDisplayName,
  type SmartleadCampaign,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import type { CampaignNameRow } from "../clients/supabase.js";
import { asNumber, unwrap } from "./parse.js";

export interface ResolvedClient {
  clientId: number | null;
  clientName: string;
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
 * Bind a campaign to exactly one client. Smartlead `client_id` wins.
 * A stale campaignintelligence `client_name` must never move another
 * client's volume onto BCP (or anyone else).
 *
 * No campaign-name substring matching — untagged campaigns stay Unknown
 * unless Supabase has a client id or a name and no conflicting id.
 */
export function resolveClient(
  campaign: Pick<SmartleadCampaign, "id" | "client_id">,
  clientsById: Map<number, SmartleadClientRecord>,
  supabaseCampaigns: Map<number, CampaignNameRow>,
  registry: Map<number, string>,
  detail?: unknown,
): ResolvedClient {
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
  campaign: Pick<SmartleadCampaign, "id" | "client_id">,
  clientsById: Map<number, SmartleadClientRecord>,
  supabaseCampaigns: Map<number, CampaignNameRow>,
  registry: Map<number, string>,
  detail?: unknown,
): string {
  return resolveClient(campaign, clientsById, supabaseCampaigns, registry, detail)
    .clientName;
}
