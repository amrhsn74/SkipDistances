import { currentUser } from "@/api/request";
import { prisma } from "@/db";

import { PageHeader } from "../../../components/Page";
import { ChatThread } from "../../../components/chat/ChatThread";
import { ClientGuidePanel } from "../../../components/chat/ClientGuidePanel";
import { chatThread } from "../../../components/chat/loadChat";
import { AssignPanel } from "./AssignPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conversation · Skip Studio" };

export default async function Page({ params }: { params: { id: string } }) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const { conversation, clientName, turns, items, brandClauses } = await chatThread(
    user,
    params.id,
  );

  // The creators who may be handed this client's work. The same rule
  // `taskAssignment` enforces on the write path -- read here only so the picker
  // does not offer someone the server would refuse.
  const creators = await prisma.clientAssignment.findMany({
    where: { client_id: conversation.client_id, role_on_client: "content_creator" },
    select: { user: { select: { user_id: true, name: true } } },
  });

  const assignable = await prisma.contentItem.findMany({
    where: conversation.campaign_id
      ? { campaign_id: conversation.campaign_id }
      : { content_item_id: "none" },
    orderBy: { created_at: "asc" },
    select: {
      content_item_id: true,
      content_form: true,
      platform: true,
      status: true,
      assigned_to_id: true,
    },
  });

  return (
    <>
      <PageHeader
        title={conversation.title ?? clientName}
        description={`Working for ${clientName}.`}
      />
      <div className="mb-4">
        <ClientGuidePanel clientName={clientName} clauses={brandClauses} />
      </div>

      <ChatThread
        conversationId={conversation.conversation_id}
        initialTurns={turns}
        items={items}
        clientName={clientName}
      />
      {assignable.length > 0 ? (
        <div className="mt-4">
          <AssignPanel
            items={assignable}
            creators={creators.map((row) => row.user)}
          />
        </div>
      ) : null}
    </>
  );
}
