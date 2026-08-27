import { currentUser } from "@/api/request";

import { PageHeader } from "../../../components/Page";
import { ChatThread } from "../../../components/chat/ChatThread";
import { ClientGuidePanel } from "../../../components/chat/ClientGuidePanel";
import { chatThread } from "../../../components/chat/loadChat";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conversation · Skip Studio" };

export default async function Page({ params }: { params: { id: string } }) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const { conversation, clientName, turns, items, brandClauses } = await chatThread(
    user,
    params.id,
  );

  return (
    <>
      <PageHeader
        title={conversation.title ?? clientName}
        description={`Working for ${clientName}.`}
      />
      {/* The client's own rules, on the thread they govern. Collapsed by
          default -- a creator arrives to write, not to read. */}
      <div className="mb-4">
        <ClientGuidePanel clientName={clientName} clauses={brandClauses} />
      </div>

      <ChatThread
        conversationId={conversation.conversation_id}
        initialTurns={turns}
        items={items}
        clientName={clientName}
      />
    </>
  );
}
