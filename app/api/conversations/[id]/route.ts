import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";
import { loadConversation } from "@/domain/conversations";

/**
 * One thread, with its turns and what it produced.
 *
 * Access is `loadConversation`'s: the caller owns the thread, or is the agency
 * admin reading it for conduct review. Nobody else, including another creator on
 * the same client -- a transcript is one person's record, and the misuse queue
 * depends on that being true.
 */

// Reads the session cookie. Never cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/conversations/[id]
 *
 * Returns the turns oldest first, plus the items the thread produced where it
 * has produced any. The items are read from the campaign the thread is linked
 * to, not from a copy held on the conversation -- there is one home for a
 * content item, and a screen reading a second one would eventually disagree with
 * the review queue about what exists.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const conversation = await loadConversation(user, params.id);

    const items = conversation.campaign_id
      ? await prisma.contentItem.findMany({
          where: { campaign_id: conversation.campaign_id },
          orderBy: { created_at: "asc" },
          select: {
            content_item_id: true,
            content_form: true,
            platform: true,
            content_body: true,
            status: true,
            market_id: true,
            scheduled_date: true,
            assigned_to_id: true,
            citations: { select: { clause_id: true } },
          },
        })
      : [];

    return NextResponse.json({
      conversation_id: conversation.conversation_id,
      client_id: conversation.client_id,
      campaign_id: conversation.campaign_id,
      title: conversation.title,
      status: conversation.status,
      updated_at: conversation.updated_at,
      turns: conversation.turns.map((turn) => ({
        turn_id: turn.turn_id,
        role: turn.role,
        body: turn.body,
        // Present on a refused turn. A screen shows it as such; the Admin's
        // queue row links back to this turn by the same id.
        flag_id: turn.flag_id,
        created_at: turn.created_at,
      })),
      items: items.map((item) => ({
        ...item,
        citations: item.citations.map((citation) => citation.clause_id),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
