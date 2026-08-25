import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SESSION_COOKIE, currentUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";
import { writeAudit } from "@/domain/auditLog";
import {
  WeakPasswordError,
  hashPassword,
  verifyPassword,
} from "@/domain/password";
import { SESSION_TTL_HOURS, createSession, revokeAllSessions } from "@/domain/session";

/**
 * Set your own password.
 *
 * Deliberately uses `currentUser`, not `requireUser`. `requireUser` refuses a
 * session carrying `must_change_password` -- which is every session that needs
 * this endpoint. Using it here would make the forced password step impossible to
 * complete, so this is the one route that accepts such a session, and it accepts
 * it for exactly one action.
 *
 * Two callers: a contact who just redeemed a code and must set a first password,
 * and a signed-in user changing one they already have. The difference is whether
 * the current password is required -- a user who has one must prove it, or
 * anyone borrowing an unlocked browser could lock the owner out.
 */
export const dynamic = "force-dynamic";

/** POST /api/auth/password -- `{ new_password, current_password? }`. */
export async function POST(request: Request) {
  try {
    const acting = await currentUser();
    if (!acting) {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } },
        { status: 401 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const newPassword = asString(body.new_password ?? body.newPassword);
    const currentPassword = asString(body.current_password ?? body.currentPassword);

    const user = await prisma.user.findUniqueOrThrow({
      where: { user_id: acting.user_id },
    });

    // A user who already holds a password must prove it. Skipped only for the
    // first-password case, where there is nothing to prove and the one-time code
    // was the proof.
    if (user.password_hash) {
      const matches = await verifyPassword(currentPassword, user.password_hash);
      if (!matches) {
        return NextResponse.json(
          {
            error: {
              code: "CURRENT_PASSWORD_WRONG",
              message: "That is not your current password.",
              issues: { current_password: "Does not match." },
            },
          },
          { status: 422 },
        );
      }
    }

    // Throws `WeakPasswordError` below the minimum length; `errorResponse` does
    // not know that class, so it is mapped here rather than left to become a 500.
    let hash: string;
    try {
      hash = await hashPassword(newPassword);
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        return NextResponse.json(
          {
            error: {
              code: error.code,
              message: error.message,
              issues: { new_password: error.message },
            },
          },
          { status: 422 },
        );
      }
      throw error;
    }

    await prisma.user.update({
      where: { user_id: user.user_id },
      data: { password_hash: hash, must_change_password: false },
    });

    // Every other session for this user dies with the old password. The reason
    // the endpoint bothers: if the password is being changed *because* someone
    // else got in, leaving their session live makes the change cosmetic.
    await revokeAllSessions(user.user_id);

    await writeAudit({
      entityType: "User",
      entityId: user.user_id,
      action: "edited",
      performedById: user.user_id,
      // No password, no hash. That a password changed is the auditable fact.
      details: { password_changed: true },
    });

    // `revokeAllSessions` killed the caller's own session too, so a fresh one is
    // issued and the cookie replaced. Without this the user would set a password
    // and be bounced to sign-in by their next click, which reads as a failure.
    const session = await createSession({
      userId: user.user_id,
      ttlHours: SESSION_TTL_HOURS,
    });

    const response = NextResponse.json({ password_set: true });
    response.cookies.set({
      name: SESSION_COOKIE,
      value: session.token,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
