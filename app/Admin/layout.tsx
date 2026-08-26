import { AppShell } from "../components/AppShell";
import { requireRole } from "../components/requireRole";

/**
 * Everything under `/Admin` is the agency admin's-only.
 *
 * The guard is in the layout rather than in each page so a page added later is
 * protected by existing -- the failure this prevents is a new screen that
 * forgets its own check and quietly serves another role's data.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, role } = await requireRole("agency_admin");

  return (
    <AppShell role={role} userId={user.user_id} userName={user.name}>
      {children}
    </AppShell>
  );
}
