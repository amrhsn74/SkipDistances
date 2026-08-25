import Link from "next/link";

import type { EffectiveRole } from "@/domain/accessScope";
import { ROLE_LABEL, ROLE_NAV } from "@/domain/roleRoutes";

import { SignOutButton } from "./SignOutButton";

/**
 * The frame every signed-in page sits in: brand, role nav, who you are, sign out.
 *
 * A server component. It is handed the role rather than resolving it, because
 * each role's layout has already resolved the session to decide whether to
 * render at all -- resolving twice would mean two database round trips per page
 * and, worse, two places that could disagree about who is asking.
 *
 * The nav comes from `roleRoutes`, so what is drawn cannot drift from what the
 * middleware admits. Hiding a link is presentation, never protection: every page
 * behind these still enforces for itself.
 */
export function AppShell({
  role,
  userName,
  children,
}: {
  role: EffectiveRole;
  userName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <span className="text-lg font-semibold tracking-tight">Skip Studio</span>

          <nav className="flex flex-1 items-center gap-1">
            {ROLE_NAV[role].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500">
              {userName} · {ROLE_LABEL[role]}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
