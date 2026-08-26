import { currentUser } from "@/api/request";

import { PageHeader } from "../../../components/Page";
import { ChatThread } from "../../../components/chat/ChatThread";
import { chatThread } from "../../../components/chat/loadChat";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conversation · Skip Studio" };

export default async function Page({ params }: { params: { id: string } }) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const { conversation, clientName, turns, items } = await chatThread(user, params.id);

  return (
    <>
      <PageHeader
        title={conversation.title ?? clientName}
        description={`Working for ${clientName}.`}
      />
      <ChatThread
        conversationId={conversation.conversation_id}
        initialTurns={turns}
        items={items}
        clientName={clientName}
      />
    </>
  );
}
