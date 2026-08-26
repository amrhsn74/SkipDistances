import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import { prisma } from "@/db";
import { takeDown } from "@/domain/publish";
import { publisherFor } from "@/instagram/client";

/**
 * Taking a live post down.
 *
 * Staff-only via `publish.take_down`, which the client contact deliberately does
 * not hold: a client withdraws an *approval*, and that is a different act with a
 * different trail. Once something is live, removing it is the agency's action.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/** POST /api/content-items/[id]/takedown */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const item = await prisma.contentItem.findUnique({
      where: { content_item_id: params.id },
      select: { campaign: { select: { client_id: true } } },
    });

    // An unknown item passes an undefined client and is denied by scope, which
    // is correct: a caller must not learn from the status whether an item they
    // cannot see exists.
    await enforce(user, "publish.take_down", { clientId: item?.campaign.client_id });

    await takeDown(params.id, user.user_id, publisherFor());

    return NextResponse.json({ content_item_id: params.id, status: "declined" });
  } catch (error) {
    return errorResponse(error);
  }
}
