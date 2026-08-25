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
 *
 * Outlined in white rather than filled: it sits at the foot of the dark
 * sidebar, where a filled amber button would outrank the nav's current-page
 * highlight -- and signing out is not the most important thing on the screen.
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
      className="skip-display w-full rounded-pill border-2 border-white/30 px-4 py-2 text-sm font-bold text-white/80 transition-colors hover:border-white hover:bg-white hover:text-ink disabled:opacity-50"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
