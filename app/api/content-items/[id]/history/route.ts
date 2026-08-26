import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import { regenerationHistory, serializeHistory } from "@/domain/regenerationHistory";
import { prisma } from "@/db";

/**
 * Which reference produced which draft, over HTTP.
 *
 * Fetched on demand rather than loaded with the queue, deliberately. A history
 * is two queries per item, and a twenty-item page would spend forty of them to
 * populate panels that are closed by default -- the N+1 that a list screen most
 * easily grows. Opening one panel costs one request.
 *
 * `campaign.view` rather than `content.regenerate`: reading who attached what is
 * exactly the reviewer's question, not only the creator's. The ERD's reason for
 * accumulating attachment rows is "so a **reviewer** can see which reference
 * produced which version", and a capability only the creator held would keep it
 * from the person it was kept for.
 */

// Reads the session cookie. Never cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/content-items/[id]/history
 *
 * Answers the runs newest first, plus any attachments no recorded run claims --
 * the references from a regeneration that was refused, which are the ones most
 * worth seeing.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const contentItemId = params.id;

    // The capability is client-scoped, so the item is resolved to its client
    // first. An unknown item is denied by scope rather than answering 404, so a
    // caller learns nothing about items they cannot see.
    const clientId = await clientOf(contentItemId);

    await enforce(user, "campaign.view", { clientId: clientId ?? undefined });

    // Scoped again inside, which is not redundant: `enforce` answers "may this
    // role do this on this client", and the query answers "is this item in this
    // user's scope at all". An item whose client resolved to null would pass
    // neither, and the read returns an empty history rather than throwing.
    const history = await regenerationHistory(user, contentItemId);

    return NextResponse.json(serializeHistory(history));
  } catch (error) {
    return errorResponse(error);
  }
}

/** The client this item belongs to, or null if there is no such item. */
async function clientOf(contentItemId: string): Promise<string | null> {
  const item = await prisma.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { campaign: { select: { client_id: true } } },
  });
  return item?.campaign.client_id ?? null;
}
