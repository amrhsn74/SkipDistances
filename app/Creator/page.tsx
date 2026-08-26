import { currentUser } from "@/api/request";
import { prisma } from "@/db";
import { creatorOverview } from "@/domain/creatorQueue";
import { listConversations } from "@/domain/conversations";

import { PageHeader } from "../components/Page";
import { CreatorOverview } from "./CreatorOverview";

/**
 * What needs this creator.
 *
 * Deliberately not the account manager's overview with a narrower scope. That
 * screen answers "where does every account stand", which is a manager's
 * question; this one answers "what is mine to work on", and the two want
 * different numbers in front. Flagged work leads, because the engine refusing
 * something is the only state where nothing moves until a person acts.
 *
 * Scope is `clientScopeWhere`'s, reached through `creatorOverview` -- the same
 * call the assignments queue makes, so this page and the list it links into
 * cannot disagree about what a creator can see.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function CreatorHome() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const [{ counts, clients }, threads] = await Promise.all([
    creatorOverview(user),
    listConversations(user),
  ]);

  // The three most recent threads, named by client so the shortcut is legible
  // without opening it.
  const recent = threads.slice(0, 3);
  const names = new Map(clients.map((client) => [client.client_id, client.name]));

  // A thread may belong to a client that has since left this creator's scope --
  // the transcript is still theirs to read, so the row is kept and the client
  // resolved separately rather than dropped.
  const missing = recent
    .map((thread) => thread.clientId)
    .filter((clientId) => !names.has(clientId));

  if (missing.length > 0) {
    const rows = await prisma.client.findMany({
      where: { client_id: { in: missing } },
      select: { client_id: true, name: true },
    });
    for (const row of rows) names.set(row.client_id, row.name);
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your assigned clients, and what needs you."
      />
      <CreatorOverview
        counts={counts}
        clients={clients}
        recentThreads={recent.map((thread) => ({
          conversation_id: thread.conversationId,
          title: thread.title,
          client_name: names.get(thread.clientId) ?? thread.clientId,
        }))}
      />
    </>
  );
}
