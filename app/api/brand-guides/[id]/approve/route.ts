import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import {
  approveBrandGuideVersion,
  clientOfVersion,
  declineBrandGuideVersion,
  serializeVersion,
} from "@/domain/brandGuides";
import { enforce } from "@/domain/permissions";

/**
 * The client's sign-off on a new version of their own brand guide.
 *
 * This is the endpoint that makes the guide's version history mean something.
 * Everything on `/api/brand-guides` is the account manager drafting and
 * submitting; **only this route activates**, and only for a caller holding
 * `brand_guide.approve` -- which, in the capability table, is the client contact
 * alone. An account manager cannot approve their own edit, by the same reasoning
 * that keeps them from recording the client's stage of a content approval.
 *
 * Activation is not a status change alone. `approveBrandGuideVersion` supersedes
 * the outgoing version, promotes this one, and repoints
 * `Client.active_brand_guide_id` in a single transaction -- so from the engine's
 * side the client's governing rules change exactly once, at this moment, and
 * never sit in a half-applied state.
 *
 * Declining is on the same route rather than a separate one, for the reason the
 * approvals endpoint serves approve and decline together: they are the same
 * decision with opposite answers, taken by the same person at the same point.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/brand-guides/[id]/approve
 *
 * `{ decision: "approve" }` -- the default -- activates the version.
 * `{ decision: "decline", comment }` sends it back to its author as a draft,
 * leaving the currently active guide untouched.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const versionId = params.id;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // The capability is client-scoped, so the version has to be resolved to its
    // client before the check can mean anything. An unknown id is denied by
    // scope rather than answering 404, so a caller learns nothing about guides
    // they cannot see.
    const clientId = await clientOfVersion(versionId);

    await enforce(user, "brand_guide.approve", { clientId: clientId ?? undefined });

    const decision = asString(body.decision) || "approve";

    if (decision === "decline") {
      const declined = await declineBrandGuideVersion(
        versionId,
        user.user_id,
        optionalString(body.comment) ?? null,
      );
      return NextResponse.json(serializeVersion(declined));
    }

    const approved = await approveBrandGuideVersion(versionId, user.user_id);

    return NextResponse.json(serializeVersion(approved));
  } catch (error) {
    return errorResponse(error);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
