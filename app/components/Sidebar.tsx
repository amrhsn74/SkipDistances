"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { EffectiveRole } from "@/domain/accessScope";
import { ROLE_HOME, ROLE_LABEL, ROLE_NAV } from "@/domain/roleRoutes";

import { Avatar } from "./Avatar";
import { NavIcon } from "./NavIcon";
import { SignOutButton } from "./SignOutButton";

/**
 * The persistent sidebar.
 *
 * A client component because the active item needs `usePathname`. It stays
 * mounted across navigations -- that is the point of moving here from a top bar:
 * a reader keeps their place in the structure while the page beside them
 * changes, and there is room for the sections Phases 6-11 add without the nav
 * running out of horizontal space.
 *
 * The nav comes from `roleRoutes`, so what is drawn cannot drift from what the
 * middleware admits. Hiding a link is presentation, never protection: every page
 * behind these still enforces for itself.
 */
export function Sidebar({
  role,
  userId,
  userName,
}: {
  role: EffectiveRole;
  userId: string;
  userName: string;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col bg-ink">
      <div className="flex h-20 items-center px-6">
        <Link href={ROLE_HOME[role]} className="flex items-center">
          {/*
            The wordmark is black on transparent, and this bar is dark. Inverted
            in CSS rather than shipped as a second asset: one file stays the
            source of truth, so a future logo change cannot leave a stale light
            variant behind on exactly one screen.
          */}
          <Image
            src="/brand/logo.webp"
            alt="Skip Studio"
            width={172}
            height={80}
            priority
            className="h-9 w-auto brightness-0 invert"
          />
        </Link>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {ROLE_NAV[role].map((item) => {
          // The role home matches exactly; everything else matches its subtree.
          // A `startsWith` on the home would leave "Overview" lit on every page,
          // since every route beneath a role starts with it.
          const isHome = item.href.split("/").filter(Boolean).length === 1;
          const active = isHome ? pathname === item.href : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "skip-display flex items-center gap-3 rounded-xl bg-amber-brand px-3 py-2.5 text-sm font-bold text-ink"
                  : "skip-display flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              }
            >
              <NavIcon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="mb-3 flex items-center gap-2.5 px-2">
          <Avatar userId={userId} name={userName} role={role} size="lg" />
          <p className="min-w-0">
            <span className="block truncate text-sm font-semibold text-white">{userName}</span>
            <span className="block text-xs text-amber-brand">{ROLE_LABEL[role]}</span>
          </p>
        </div>
        <SignOutButton />
      </div>
    </aside>
  );
}
