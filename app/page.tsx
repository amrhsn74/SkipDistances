import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { currentUser } from "@/api/request";
import { SESSION_COOKIE, STALE_SESSION_MARKER } from "@/config/session";
import { effectiveRole } from "@/domain/accessScope";
import { ROLE_HOME } from "@/domain/roleRoutes";

/**
 * The root, which nobody stays on.
 *
 * There is no anonymous landing page in this product -- PRD §4 has every role
 * signing in -- so `/` exists only to work out where the visitor belongs and
 * send them there.
 *
 * The stale cookie is **not** cleared here, and that is deliberate rather than
 * an omission: Next forbids mutating cookies while rendering a page, so
 * `cookies().delete()` throws a server exception instead of fixing anything.
 * What this page can do is *report* the fact -- it is the only place that knows
 * a cookie was presented and resolved to nobody -- by flagging the redirect. The
 * middleware reads the flag and clears the cookie on a real response, which it
 * can. See the note there.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();

  if (!user) {
    // Flag the trip only when a cookie was actually sent. An ordinary
    // signed-out visitor needs no repair, and marking their redirect would put
    // a meaningless query string on the sign-in page everyone lands on.
    const stale = Boolean(cookies().get(SESSION_COOKIE)?.value);
    redirect(stale ? `/signin?${STALE_SESSION_MARKER}` : "/signin");
  }
  if (user.must_change_password) redirect("/password");

  redirect(ROLE_HOME[await effectiveRole(user)]);
}
