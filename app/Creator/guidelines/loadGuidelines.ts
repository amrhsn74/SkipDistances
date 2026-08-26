import { prisma } from "@/db";
import { visibleClientIds } from "@/domain/accessScope";
import { getGuidelinesForClient, type ScopedClause } from "@/domain/retrievalScope";
import type { ActingUser } from "@/api/request";

/**
 * The rules a creator writes under, for every client they work for.
 *
 * A creator is told after the fact which clauses a draft cited. Until now there
 * was nowhere to read them *before* writing -- the guide existed in the engine's
 * prompt and on the client's own screen, and the person actually producing the
 * work could only infer it from citations. This is that screen.
 *
 * Scoped by `visibleClientIds`, exactly as the chat path is. A creator sees the
 * guides of the clients they are assigned to and no others: the same Clause 0.7
 * boundary the retrieval query enforces, applied to reading rather than to
 * drafting. Nothing here widens what anyone can see.
 *
 * The clauses come from `getGuidelinesForClient` rather than from a query
 * written here, so what a creator reads is by construction what the engine
 * retrieves -- including the active-version scoping. A separate query would be
 * free to drift, and a guide screen that disagrees with the engine is worse than
 * no guide screen at all.
 */

export type ClientGuidelines = {
  client_id: string;
  name: string;
  industry: string;
  /** Null when the client has no brand guide -- the majority of the roster. */
  brandGuideVersionId: string | null;
  agency: ScopedClause[];
  brand: ScopedClause[];
};

export async function creatorGuidelines(user: ActingUser): Promise<ClientGuidelines[]> {
  const ids = await visibleClientIds(user);

  const clients = await prisma.client.findMany({
    where: { client_id: { in: ids }, status: "active" },
    select: { client_id: true, name: true, industry: true },
    orderBy: { name: "asc" },
  });

  // Sequential rather than parallel: a creator is assigned to a handful of
  // clients, and one query per client against SQLite is cheaper than the
  // connection pressure of fanning out.
  const out: ClientGuidelines[] = [];
  for (const client of clients) {
    const scope = await getGuidelinesForClient(client.client_id);
    out.push({
      client_id: client.client_id,
      name: client.name,
      industry: client.industry,
      brandGuideVersionId: scope.brandGuideVersionId,
      agency: scope.agency,
      brand: scope.brand,
    });
  }

  return out;
}
