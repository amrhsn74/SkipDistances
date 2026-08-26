import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { assignItem } from "@/domain/taskAssignment";

/**
 * Dispatching one item to a creator, over HTTP.
 *
 * The capability, the client scope and the "must be a creator on this client"
 * rule are all `assignItem`'s. This handler reads a body and calls it -- the
 * authorisation lives on the write path so a second caller added later cannot
 * skip it.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/content-items/[id]/assign
 *
 * `assignee_id: null` clears the assignment. Answers 200 rather than 201: the
 * item already existed, and this changed a field on it.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;
    const raw = body.assignee_id ?? body.assigneeId;

    // Null and absent both mean "clear it". A wrong type becomes null rather
    // than throwing, so the caller gets a domain error instead of a 500.
    const assigneeId = typeof raw === "string" && raw.trim() !== "" ? raw : null;

    const result = await assignItem(user, params.id, assigneeId);

    return NextResponse.json({
      content_item_id: result.contentItemId,
      client_id: result.clientId,
      previous_assignee_id: result.previousAssigneeId,
      assignee_id: result.assigneeId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
