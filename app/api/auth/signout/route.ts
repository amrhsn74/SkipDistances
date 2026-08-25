import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { revokeSession } from "@/domain/session";

/**
 * Sign out.
 *
 * POST only. A GET that ends a session is a session any page on the internet can
 * end for you with an `<img src>`; harmless here, but the same shape is how a
 * state-changing GET becomes a real problem later.
 *
 * Both halves matter: the row is revoked *and* the cookie cleared. Clearing only
 * the cookie would leave a live session behind for anyone who kept the token,
 * and revoking only the row would leave the browser sending a dead cookie on
 * every request.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const token = cookies().get(SESSION_COOKIE)?.value;

    // Idempotent by design -- signing out twice, or with no session at all, is
    // not an error. A sign-out that fails on a double click is worse than one
    // that does nothing.
    await revokeSession(token);

    const response = NextResponse.json({ signed_out: true });
    response.cookies.set({
      name: SESSION_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
