import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { currentUser } from "@/api/request";
import { SESSION_COOKIE, STALE_SESSION_MARKER } from "@/config/session";
import { effectiveRole, type EffectiveRole } from "@/domain/accessScope";
import { ROLE_HOME } from "@/domain/roleRoutes";

/**
 * What each role's layout calls before rendering anything.
 *
 * The middleware already turned away visitors with no session, but middleware
 * cannot be the whole answer: it runs on the edge without database access, so it
 * can see that a session cookie exists and not what role it belongs to. This is
 * the half that reads the row -- and it runs on the server for every page under
 * the layout, so a role who types another role's URL is sent home rather than
 * shown a page whose data would then have to refuse them field by field.
 *
 * Redirect rather than 403, deliberately. A signed-in account manager who lands
 * on `/Admin` has made a navigation mistake, not an attack, and their own home
 * is the useful answer. The attack case is covered anyway: every page's data
 * still comes through `enforce`, which flags.
 */
export async function requireRole(
  expected: EffectiveRole,
): Promise<{ user: NonNullable<Awaited<ReturnType<typeof currentUser>>>; role: EffectiveRole }> {
  const user = await currentUser();

  // No session, or a session whose user must still set a password. Both are the
  // middleware's job on a normal request; repeated here because a layout must
  // never render on the assumption that middleware ran.
  if (!user) {
    // Same handshake as `app/page.tsx`. A cookie that reached here and resolved
    // to nobody is dead, and saying so on the redirect is what lets the
    // middleware clear it -- without the flag it would bounce this visitor to
    // `/` and back here forever, since the edge can only see that a cookie
    // exists.
    const stale = Boolean(cookies().get(SESSION_COOKIE)?.value);
    redirect(stale ? `/signin?${STALE_SESSION_MARKER}` : "/signin");
  }
  if (user.must_change_password) redirect("/password");

  const role = await effectiveRole(user);
  if (role !== expected) redirect(ROLE_HOME[role]);

  return { user, role };
}
