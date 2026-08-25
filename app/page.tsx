import { redirect } from "next/navigation";

import { currentUser } from "@/api/request";
import { effectiveRole } from "@/domain/accessScope";
import { ROLE_HOME } from "@/domain/roleRoutes";

/**
 * The root, which nobody stays on.
 *
 * There is no anonymous landing page in this product -- PRD §4 has every role
 * signing in -- so `/` exists only to work out where the visitor belongs and
 * send them there.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (user.must_change_password) redirect("/password");

  redirect(ROLE_HOME[await effectiveRole(user)]);
}
