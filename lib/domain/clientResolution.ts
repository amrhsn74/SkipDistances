import { prisma, type Db } from "../db";
import { flag, ok, type Outcome } from "./decision";

/**
 * Clause 0.6 — Unknown or inactive clients.
 *
 * "Content is produced only for active clients on the roster. A brief for a
 * client not on the roster, or one marked inactive, is flagged to a human, not
 * drafted."
 *
 * This is the engine's second step and its first hard gate: nothing downstream
 * runs for a client that fails here. Both failure modes cite the same clause but
 * carry different flag types, because "we have never heard of this client" and
 * "this client left" are different situations for the human who picks the flag up.
 */

export const CLAUSE_UNKNOWN_OR_INACTIVE = "0.6";

export type ResolvedClient = {
  client_id: string;
  name: string;
  industry: string;
  status: string;
  tier: string | null;
  channels: string[];
  account_manager_id: string | null;
  active_brand_guide_id: string | null;
  sensitive_sector: boolean;
  /** Every market the client operates in. Never empty for a seeded client. */
  marketIds: string[];
};

export async function resolveClient(
  clientId: string | null | undefined,
  db: Db = prisma,
): Promise<Outcome<ResolvedClient>> {
  // A brief with no client id at all is an unknown client, not a crash --
  // B-026 ("Client: not on roster") is exactly this case.
  if (!clientId) {
    return flag(
      CLAUSE_UNKNOWN_OR_INACTIVE,
      "unknown_client",
      "The brief does not name a client on the roster.",
    );
  }

  const client = await db.client.findUnique({
    where: { client_id: clientId },
    include: { markets: { select: { market_id: true } } },
  });

  if (!client) {
    return flag(
      CLAUSE_UNKNOWN_OR_INACTIVE,
      "unknown_client",
      `Client ${clientId} is not on the roster.`,
    );
  }

  if (client.status !== "active") {
    return flag(
      CLAUSE_UNKNOWN_OR_INACTIVE,
      "inactive_client",
      `Client ${clientId} (${client.name}) is marked ${client.status}.`,
    );
  }

  return ok({
    client_id: client.client_id,
    name: client.name,
    industry: client.industry,
    status: client.status,
    tier: client.tier,
    channels: parseChannels(client.channels),
    account_manager_id: client.account_manager_id,
    active_brand_guide_id: client.active_brand_guide_id,
    sensitive_sector: client.sensitive_sector,
    marketIds: client.markets.map((m: { market_id: string }) => m.market_id),
  });
}

/** channels is stored JSON-encoded -- SQLite has no array type. */
function parseChannels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
