import { prisma } from "@/db";
import { visibleClientIds } from "@/domain/accessScope";
import { getGuidelinesForClient, type ScopedClause } from "@/domain/retrievalScope";
import type { ActingUser } from "@/api/request";

/**
 * The rules a creator writes under, read before the writing rather than only
 * cited after it.
 *
 * Split in two on purpose, because the two halves answer different questions at
 * different moments:
 *
 *   - `agencyStandards` is the handbook that governs every client. It is the
 *     same text whoever is asking, so it lives in the nav as a standing
 *     reference -- something to consult, not something scoped to a task.
 *   - `clientGuidelines` is one client's own brand guide, which is only
 *     meaningful once you know which client you are writing for. That question
 *     is answered on the chat screen, when a client is chosen, so the brand
 *     rules surface there rather than in a nav page listing every client's
 *     guide at once.
 *
 * Both come from `getGuidelinesForClient` rather than from queries written here,
 * so what a creator reads is by construction what the engine retrieves --
 * including the active-version scoping. A separate query would be free to drift,
 * and a guide screen that disagrees with the engine is worse than no guide
 * screen at all.
 */

export type ClientGuidelines = {
  client_id: string;
  name: string;
  industry: string;
  /** Null when the client has no brand guide -- the majority of the roster. */
  brandGuideVersionId: string | null;
  brand: ScopedClause[];
};

/**
 * The agency handbook. Global and unversioned: it governs every client,
 * including the ones with no brand guide of their own.
 *
 * Read through the same scoped query the engine uses rather than by querying
 * `source_type = "agency"` directly, so this page and the drafting step can
 * never disagree about what the standards are. Any client id resolves the same
 * agency set; the first visible one is used simply because the query needs one.
 */
export async function agencyStandards(user: ActingUser): Promise<ScopedClause[]> {
  const [firstVisible] = await visibleClientIds(user);
  if (!firstVisible) return [];
  return (await getGuidelinesForClient(firstVisible)).agency;
}

/**
 * One client's own brand rules.
 *
 * Takes a client id rather than discovering one, because the caller always
 * knows it: this is rendered on a chat thread, which is scoped to a client by
 * construction. Returns null when the caller may not see that client -- the same
 * `visibleClientIds` boundary the rest of the chat path uses, so a guessed id in
 * a URL reveals nothing.
 */
export async function clientGuidelines(
  user: ActingUser,
  clientId: string,
): Promise<ClientGuidelines | null> {
  const ids = await visibleClientIds(user);
  if (!ids.includes(clientId)) return null;

  const client = await prisma.client.findUnique({
    where: { client_id: clientId },
    select: { client_id: true, name: true, industry: true },
  });
  if (!client) return null;

  const scope = await getGuidelinesForClient(clientId);

  return {
    client_id: client.client_id,
    name: client.name,
    industry: client.industry,
    brandGuideVersionId: scope.brandGuideVersionId,
    brand: scope.brand,
  };
}
