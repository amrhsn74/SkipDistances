import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { resolveFlag } from "@/domain/misuse";
import { enforce } from "@/domain/permissions";

/**
 * Resolving a governance flag.
 *
 * `flag.resolve` is unscoped -- the Admin's queue is cross-client by design, and
 * a flag about conduct is not about one client's work. That is why `enforce` is
 * called with no client context here, unlike almost every other route.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * PATCH /api/flags/[id] -- mark a flag resolved, with notes.
 *
 * Notes are required rather than optional. A flag closed with no explanation
 * leaves the trail saying an admin looked at something and decided nothing,
 * which is worse than leaving it open: the row disappears from the queue and
 * takes the reason with it.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "flag.resolve");

    const body = (await request.json()) as Record<string, unknown>;
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";

    if (!notes) {
      return NextResponse.json(
        {
          error: {
            code: "FLAG_VALIDATION",
            message: "Say what was done about it.",
            issues: { notes: "A resolution needs a note." },
          },
        },
        { status: 422 },
      );
    }

    const resolved = await resolveFlag({ flagId: params.id, notes, byAdminId: user.user_id });

    return NextResponse.json({
      flag_id: resolved.flag_id,
      resolved: resolved.resolved,
      resolution_notes: resolved.resolution_notes,
      resolved_at: resolved.resolved_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
