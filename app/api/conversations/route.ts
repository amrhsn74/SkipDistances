import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { listConversations, openConversation } from "@/domain/conversations";

/**
 * Threads, over HTTP.
 *
 * The same shell as the other Phase 4 routes: resolve who is asking, hand the
 * work to the domain layer, map a thrown error to a status. Neither handler
 * checks a capability itself -- `openConversation` enforces `content.chat`
 * against the named client, and `listConversations` is scoped to the caller by
 * construction. A check written here as well would be a second copy of a rule
 * that already has one place to live.
 */

// Reads the session cookie; POST writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/conversations -- the caller's own threads, most recently touched
 * first.
 *
 * Deliberately not filterable by user: a thread list is the caller's own, and an
 * endpoint that accepted a `user_id` would be an endpoint someone eventually
 * calls with a colleague's. The Admin reads other people's threads through the
 * misuse queue, which is a different screen answering a different question.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const conversations = await listConversations(user);

    return NextResponse.json({
      conversations: conversations.map((conversation) => ({
        conversation_id: conversation.conversationId,
        client_id: conversation.clientId,
        title: conversation.title,
        status: conversation.status,
        campaign_id: conversation.campaignId,
        updated_at: conversation.updatedAt,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/conversations -- open a thread for a client.
 *
 * 201: the thread is a real row from this moment, before a word is said in it.
 * The client is fixed here and never changes, which is what lets every later
 * turn ground in one client's rules without re-deciding whose they are.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    // Passed through as written. An unknown id is denied by scope inside
    // `openConversation`, which is the correct answer -- a caller must not learn
    // from the status code whether a client they cannot see happens to exist.
    const clientId = asString(body.client_id ?? body.clientId);
    const title = optionalString(body.title) ?? null;

    const conversation = await openConversation(user, clientId, title);

    return NextResponse.json(
      {
        conversation_id: conversation.conversationId,
        client_id: conversation.clientId,
        title: conversation.title,
        status: conversation.status,
        campaign_id: conversation.campaignId,
        updated_at: conversation.updatedAt,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Body coercion, kept deliberately dumb -- as on the campaigns route. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
