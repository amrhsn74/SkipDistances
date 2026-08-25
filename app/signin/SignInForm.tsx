"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * One form for both credentials.
 *
 * The toggle changes which field is sent, not which endpoint is called --
 * `/api/auth/signin` answers both identically, on purpose, so the response
 * cannot be used to tell whether an address holds a password or a pending code.
 */
type Mode = "password" | "code";

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        mode === "password" ? { email, password: secret } : { email, code: secret },
      ),
    });

    const body = (await response.json()) as {
      user?: { must_change_password: boolean };
      error?: { message: string };
    };

    if (!response.ok) {
      setError(body.error?.message ?? "Sign-in failed.");
      setBusy(false);
      return;
    }

    // A redeemed code lands here with the account active but unusable. The
    // password screen is the only place that session may go, and the middleware
    // would send them there anyway -- doing it explicitly avoids a visible
    // bounce through a page they cannot have.
    if (body.user?.must_change_password) {
      router.replace("/password");
    } else {
      // `next` is where the middleware was taking them before it intervened.
      // Only a same-site path is honoured: an absolute URL here would make the
      // sign-in page an open redirect, which is exactly how a phishing link gets
      // to borrow a real domain.
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    }

    // The role pages are server-rendered, so the new cookie only takes effect
    // once the router cache is dropped.
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
        />
      </div>

      <div>
        <label htmlFor="secret" className="mb-1 block text-sm font-medium text-slate-700">
          {mode === "password" ? "Password" : "One-time code"}
        </label>
        <input
          id="secret"
          type={mode === "password" ? "password" : "text"}
          required
          autoComplete={mode === "password" ? "current-password" : "one-time-code"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "password" ? "code" : "password");
          setSecret("");
          setError(null);
        }}
        className="w-full text-center text-sm text-slate-600 underline underline-offset-4 hover:text-slate-900"
      >
        {mode === "password"
          ? "I was given a one-time code"
          : "I have a password"}
      </button>
    </form>
  );
}
