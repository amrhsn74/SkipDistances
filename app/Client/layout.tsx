import { AppShell } from "../components/AppShell";
import { requireRole } from "../components/requireRole";

/**
 * Everything under `/Client` is the client contact's-only.
 *
 * The guard is in the layout rather than in each page so a page added later is
 * protected by existing -- the failure this prevents is a new screen that
 * forgets its own check and quietly serves another role's data.
 */
export const dynamic = "force-dynamic";

export default async function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, role } = await requireRole("client_contact");

  return (
    <AppShell role={role} userName={user.name}>
      {children}
    </AppShell>
  );
}
