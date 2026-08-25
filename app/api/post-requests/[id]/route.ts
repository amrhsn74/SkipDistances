import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import {
  updatePostRequest,
  withdrawPostRequest,
  type PostRequestRow,
} from "@/domain/postRequests";
import { prisma } from "@/db";

/**
 * A client changing or taking back their own calendar request.
 *
 * PRD §6: a request is not a one-shot submission. A client who picked the wrong
 * day should fix it themselves rather than filing a second request and leaving
 * the account manager to guess which one is live. The window closes when an
 * account manager takes the request into `under_review` -- an explicit action on
 * their side, so both parties can see when it stopped moving.
 *
 * `post_request.create` is the capability checked for both actions. There is
 * deliberately no separate "edit" capability: the person who may raise a request
 * is the person who may amend it while it is still theirs, and a second
 * capability would be a second thing to get wrong with no behaviour of its own.
 * What actually constrains this is the row's status, enforced in the domain
 * layer, plus the client scope enforced here.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * PATCH /api/post-requests/[id]
 *
 * `{ requested_date?, related_content_item_id? }` edits the request.
 * `{ status: "withdrawn" }` takes it back.
 *
 * Withdrawal is expressed as a status rather than a DELETE because the row is
 * kept: its comment thread is part of the client's conversation with their
 * account manager, and a request that vanishes takes that conversation with it.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const postRequestId = params.id;

    const body = (await request.json()) as Record<string, unknown>;

    // The capability is client-scoped, so the request has to be resolved to its
    // client before the check can mean anything. An unknown id is passed through
    // as an undefined client and denied by scope, which is the correct answer: a
    // caller must not learn from the status code whether a request they cannot
    // see happens to exist.
    const clientId = await clientOf(postRequestId);

    await enforce(user, "post_request.create", { clientId: clientId ?? undefined });

    const withdrawing = asString(body.status) === "withdrawn";

    const updated: PostRequestRow = withdrawing
      ? await withdrawPostRequest(postRequestId, user.user_id)
      : await updatePostRequest(
          postRequestId,
          {
            ...(body.requested_date !== undefined || body.requestedDate !== undefined
              ? { requestedDate: asDate(body.requested_date ?? body.requestedDate) }
              : {}),
            ...(body.related_content_item_id !== undefined ||
            body.relatedContentItemId !== undefined
              ? {
                  relatedContentItemId:
                    optionalString(body.related_content_item_id ?? body.relatedContentItemId) ??
                    null,
                }
              : {}),
          },
          user.user_id,
        );

    return NextResponse.json({
      post_request_id: updated.post_request_id,
      client_id: updated.client_id,
      requested_date: updated.requested_date.toISOString(),
      related_content_item_id: updated.related_content_item_id,
      status: updated.status,
      linked_campaign_id: updated.linked_campaign_id,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The client this request belongs to, or null if there is no such request. */
async function clientOf(postRequestId: string): Promise<string | null> {
  const row = await prisma.postRequest.findUnique({
    where: { post_request_id: postRequestId },
    select: { client_id: true },
  });
  return row?.client_id ?? null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(Number.NaN);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
