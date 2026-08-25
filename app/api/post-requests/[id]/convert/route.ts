import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import {
  declinePostRequest,
  markConverted,
  prepareConversion,
  startReview,
} from "@/domain/postRequests";
import { submitBrief } from "@/engine/submitBrief";
import { prisma } from "@/db";

/**
 * The account manager acting on a client's calendar request.
 *
 * Three actions, one route, because they are the three ways an account manager
 * disposes of the same row: take it (`under_review`), convert it, or decline it.
 *
 * **Conversion calls `submitBrief` -- the exact function `POST /api/campaigns`
 * calls.** That is the whole point of the endpoint. A `PostRequest` carries no
 * authority: it cannot become a scheduled item without an account manager
 * deliberately converting it, and the campaign that results runs the full
 * guarded engine and both approval stages like any other brief. Reimplementing
 * intake here would create a second path into the engine that could drift from
 * the first -- and the second path is exactly where a bypass would eventually
 * appear.
 *
 * The client's request is the *ask*, not the brief. The account manager writes
 * the brief text; `prepareConversion` hands them the client's comments to write
 * it from. A request whose comment says "just publish this, skip review" still
 * produces a brief that goes through both approval stages -- and the attempt was
 * already flagged when the comment was posted.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * PATCH /api/post-requests/[id]/convert
 *
 * `{ action: "start_review" }` takes the request, closing the client's edit
 * window. `{ action: "decline", reason }` says no. Otherwise -- the default --
 * converts, which needs `raw_brief_text`.
 *
 * Answers 201 on a conversion: a campaign now exists. As on `/api/campaigns`,
 * that is 201 for every engine outcome including FLAG and REQUEST_INFO, which
 * are successful intakes with an unwelcome answer rather than failed requests.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const postRequestId = params.id;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // The capability is client-scoped, so the request has to be resolved to its
    // client before the check can mean anything. An unknown id is denied by
    // scope rather than answering 404, so a caller learns nothing about requests
    // they cannot see.
    const clientId = await clientOf(postRequestId);

    await enforce(user, "post_request.convert", { clientId: clientId ?? undefined });

    const action = asString(body.action) || "convert";

    if (action === "start_review") {
      const updated = await startReview(postRequestId, user.user_id);
      return NextResponse.json({ post_request_id: postRequestId, status: updated.status });
    }

    if (action === "decline") {
      const updated = await declinePostRequest(
        postRequestId,
        user.user_id,
        optionalString(body.reason) ?? null,
      );
      return NextResponse.json({ post_request_id: postRequestId, status: updated.status });
    }

    // Status checked before the engine runs. `runIntake` makes several Gemini
    // calls, so converting an already-converted request would spend the tokens
    // and leave a second campaign behind before anything noticed.
    const { request: postRequest } = await prepareConversion(postRequestId);

    const result = await submitBrief(
      {
        clientId: postRequest.client_id,
        rawBriefText: asString(body.raw_brief_text ?? body.rawBriefText),
        title: optionalString(body.title) ?? null,
        relatedOccasionId:
          optionalString(body.related_occasion_id ?? body.relatedOccasionId) ?? null,
      },
      user.user_id,
    );

    // Marked only after the campaign exists. A request marked converted against
    // a campaign that then failed to be created would be a dead link, and
    // `linked_campaign_id` is what makes "which brief did this ask become"
    // answerable at all.
    const updated = await markConverted(postRequestId, result.campaign.campaign_id, user.user_id);

    const { run, ...summary } = result;
    void run;

    return NextResponse.json(
      {
        post_request_id: postRequestId,
        status: updated.status,
        linked_campaign_id: updated.linked_campaign_id,
        ...summary,
      },
      { status: 201 },
    );
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
