import { currentUser } from "@/api/request";

import { PageHeader } from "../../components/Page";
import { ThreadList } from "../../components/chat/ThreadList";
import { chatIndex } from "../../components/chat/loadChat";

/**
 * The lead's chat, reusing the creator's components rather than a second
 * implementation.
 *
 * One difference, and it is `showClient`: a lead works across every client, so
 * their thread list has to say which client each thread belongs to. A creator's
 * would be a column of near-identical values.
 *
 * This also closes a gap that predates Phase 14: the lead held
 * `content.regenerate` with no screen anywhere to reach it.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Chat · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const { threads, clients } = await chatIndex(user);

  return (
    <>
      <PageHeader
        title="Chat"
        description="Produce a plan or a piece of content, then hand it to a creator to finish."
      />
      <ThreadList
        threads={threads}
        clients={clients}
        basePath="/ContentLead/chat"
        showClient
      />
    </>
  );
}
