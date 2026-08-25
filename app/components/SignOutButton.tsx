"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Sign out.
 *
 * A POST rather than a link, because a GET that ends a session is a session any
 * page can end for you with an `<img>` tag. `router.refresh()` after it clears
 * the cached server render, so the next paint is the signed-out one rather than
 * a stale page that only corrects itself on reload.
 */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/signout", { method: "POST" });
    router.replace("/signin");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
