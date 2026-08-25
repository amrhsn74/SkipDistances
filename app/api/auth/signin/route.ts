import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";
import { redeemOtp } from "@/domain/otp";
import { verifyPassword } from "@/domain/password";
import { SESSION_TTL_HOURS, createSession } from "@/domain/session";

/**
 * The one sign-in endpoint, for both credentials this product issues: a
 * password, and the one-time code an account manager hands a new contact.
 *
 * One route rather than two because the failure message must be identical
 * whichever was tried. Split endpoints drift: `/signin` answering "wrong
 * password" while `/redeem` answers "no code issued" tells a prober which of the
 * two an address holds, and therefore which addresses exist at all.
 *
 * No business logic here. `redeemOtp` decides whether a code is live,
 * `verifyPassword` whether a password matches, `createSession` what a session
 * is; this handler picks which to call and sets a cookie.
 */

// Sets a cookie and reads the body. Never cached.
export const dynamic = "force-dynamic";

/**
 * The single message every failure gets.
 *
 * Deliberately says nothing about which half was wrong, whether the address
 * exists, or whether a code was ever issued. `redeemOtp` already returns a
 * precise `reason` for the audit trail; that reason stays server-side.
 */
const REFUSED = "That email and password or code do not match.";

/**
 * POST /api/auth/signin
 *
 * `{ email, password }` for an established account, `{ email, code }` for a
 * contact redeeming an invite. A redeemed code returns
 * `must_change_password: true`, which is what sends the browser to `/password`
 * rather than to a role home.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;

    const email = asString(body.email).trim().toLowerCase();
    const password = asString(body.password);
    const code = asString(body.code).trim();

    if (!email || (!password && !code)) {
      return refuse();
    }

    const userId = code
      ? await userIdFromCode(email, code)
      : await userIdFromPassword(email, password);

    if (!userId) return refuse();

    // Re-read rather than trusting what the branch above knew: `redeemOtp`
    // flips `status` to active and sets `must_change_password`, so the row as it
    // stands after redemption is the only accurate answer to where to send them.
    const user = await prisma.user.findUnique({ where: { user_id: userId } });
    if (!user) return refuse();

    const session = await createSession({ userId, ttlHours: SESSION_TTL_HOURS });

    const response = NextResponse.json({
      user: {
        user_id: user.user_id,
        name: user.name,
        must_change_password: user.must_change_password,
      },
    });

    response.cookies.set({
      name: SESSION_COOKIE,
      value: session.token,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Not `secure`, because this runs on http://localhost and a secure cookie
      // would simply never be stored. A deployed build would set it; nothing
      // here is deployed.
      expires: session.expiresAt,
    });

    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * A password sign-in.
 *
 * `verifyPassword` returns false for a user with no hash at all, which is what
 * makes an invited contact fail here rather than crash -- they hold a code, not
 * a password, and must use the other branch.
 */
async function userIdFromPassword(email: string, password: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  if (user.status !== "active") return null;

  const matches = await verifyPassword(password, user.password_hash);
  return matches ? user.user_id : null;
}

/**
 * A one-time code redemption.
 *
 * The redemption itself activates the account and sets `must_change_password`.
 * A session is granted here even though the account is not yet usable, because
 * the password screen needs one to know whose password it is setting --
 * `requireUser` is what refuses to let that session reach anything else.
 */
async function userIdFromCode(email: string, code: string): Promise<string | null> {
  const result = await redeemOtp(email, code);
  return result.ok ? result.userId : null;
}

function refuse() {
  return NextResponse.json(
    { error: { code: "SIGNIN_REFUSED", message: REFUSED } },
    { status: 401 },
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
