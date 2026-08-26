import type { EffectiveRole } from "@/domain/accessScope";

import { Sidebar } from "./Sidebar";

/**
 * The frame every signed-in page sits in.
 *
 * A server component that renders the client-side `Sidebar` beside its content.
 * It is handed the role rather than resolving it, because each role's layout has
 * already resolved the session to decide whether to render at all -- resolving
 * twice would mean two database round trips per page and, worse, two places that
 * could disagree about who is asking.
 *
 * The main column scrolls on its own so the sidebar stays put on a long roster,
 * which is the whole reason it is persistent.
 */
export function AppShell({
  role,
  userId,
  userName,
  children,
}: {
  role: EffectiveRole;
  userId: string;
  userName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar role={role} userId={userId} userName={userName} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
