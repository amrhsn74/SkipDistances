import { currentUser } from "@/api/request";

import { PageHeader } from "../../components/Page";
import { ThreadList } from "../../components/chat/ThreadList";
import { chatIndex } from "../../components/chat/loadChat";

/**
 * Where a creator's work starts since Phase 14.
 *
 * The client list is `visibleClientIds`', so a creator sees exactly the clients
 * they are assigned to -- the same scope their assignments queue uses, and not a
 * second rule written here.
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
        description="Produce content in conversation. Everything is grounded in the client's brand guide and the agency standards, and still goes through both approvals."
      />
      <ThreadList threads={threads} clients={clients} basePath="/Creator/chat" showClient={false} />
    </>
  );
}
