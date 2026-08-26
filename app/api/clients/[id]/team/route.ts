import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import {
  assignRole,
  clientTeam,
  reassignAccountManager,
  removeAssignment,
} from "@/domain/roleAssignment";

/**
 * Who works on a client.
 *
 * `roleAssignment` does its own `requireAdmin` check on every entry point, so
 * `enforce` here is the second of two rather than the only one. That is
 * deliberate and not redundant: `client.assign_roles` is client-scoped, so this
 * catches an account manager reaching for a client they do not hold *before* the
 * domain layer answers the narrower question of whether they are an admin. Since
 * Phase 14 both roles hold the capability, and the two checks answer different
 * questions.
 */

// Reads the session cookie; POST and DELETE write. Never cached.
export const dynamic = "force-dynamic";

/** GET /api/clients/[id]/team -- the current roster for one client. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "client.assign_roles", { clientId: params.id });

    const team = await clientTeam(params.id);
    return NextResponse.json(team);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/clients/[id]/team -- assign someone, or change the account manager.
 *
 * Two operations behind one endpoint because they are the same act from the
 * screen's point of view -- "put this person in this seat" -- and the account
 * manager is a column on `Client` rather than a `ClientAssignment` row purely as
 * a schema detail. `role: "account_manager"` routes to the reassignment path.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "client.assign_roles", { clientId: params.id });

    const body = (await request.json()) as Record<string, unknown>;
    const role = typeof body.role === "string" ? body.role : "";
    const rawUser = body.user_id ?? body.userId;
    const userId = typeof rawUser === "string" && rawUser.trim() !== "" ? rawUser : null;

    if (role === "account_manager") {
      // Null is meaningful here: a client may legitimately have no manager --
      // CL-109 is seeded that way -- so this clears rather than refusing.
      const client = await reassignAccountManager(
        { clientId: params.id, userId, byAdminId: user.user_id },
        undefined,
      );
      return NextResponse.json({ client_id: client.client_id, account_manager_id: client.account_manager_id });
    }

    if (!userId) {
      return NextResponse.json(
        {
          error: {
            code: "ROLE_ASSIGNMENT",
            message: "Name the person to assign.",
            issues: { user_id: "Required." },
          },
        },
        { status: 422 },
      );
    }

    const assignment = await assignRole({
      clientId: params.id,
      userId,
      role,
      byAdminId: user.user_id,
    });

    return NextResponse.json(
      {
        assignment_id: assignment.assignment_id,
        client_id: assignment.client_id,
        user_id: assignment.user_id,
        role_on_client: assignment.role_on_client,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/clients/[id]/team -- take someone off a client.
 *
 * The role travels in the body rather than the path because a person can hold
 * more than one on the same client, and removing "them" without saying which
 * seat would be ambiguous.
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "client.assign_roles", { clientId: params.id });

    const body = (await request.json()) as Record<string, unknown>;
    const role = typeof body.role === "string" ? body.role : "";
    const rawUser = body.user_id ?? body.userId;
    const userId = typeof rawUser === "string" ? rawUser : "";

    const removed = await removeAssignment({
      clientId: params.id,
      userId,
      role,
      byAdminId: user.user_id,
    });

    // `false` means there was nothing to remove. Answered as success rather than
    // 404: the caller asked for a state, and that state now holds.
    return NextResponse.json({ removed });
  } catch (error) {
    return errorResponse(error);
  }
}
