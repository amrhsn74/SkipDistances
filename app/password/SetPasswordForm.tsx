"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Set a first password, or change an existing one.
 *
 * `needsCurrent` comes from the server -- whether the user already holds a
 * password is a fact about their row, not something the browser should decide.
 * A contact who has just redeemed a code has none, and asking them for one they
 * were never given would be an unpassable screen.
 */
export function SetPasswordForm({ needsCurrent }: { needsCurrent: boolean }) {
  const router = useRouter();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // Checked here as well as by the server's length rule, because a mismatched
    // confirmation is the one error the server cannot see -- it only ever
    // receives the one password.
    if (next !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);

    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        new_password: next,
        ...(needsCurrent ? { current_password: current } : {}),
      }),
    });

    const body = (await response.json()) as { error?: { message: string } };

    if (!response.ok) {
      setError(body.error?.message ?? "Could not set that password.");
      setBusy(false);
      return;
    }

    // `/` resolves the role and forwards. The session cookie was replaced by the
    // response, since setting a password revokes every session including this one.
    router.replace("/");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {needsCurrent ? (
        <div>
          <label htmlFor="current" className="skip-label">
            Current password
          </label>
          <input
            id="current"
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="skip-input"
          />
        </div>
      ) : null}

      <div>
        <label htmlFor="next" className="skip-label">
          New password
        </label>
        <input
          id="next"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="skip-input"
        />
        <p className="mt-1 text-xs text-body/70">At least 8 characters.</p>
      </div>

      <div>
        <label htmlFor="confirm" className="skip-label">
          Confirm new password
        </label>
        <input
          id="confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="skip-input"
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="skip-btn skip-btn-primary w-full"
      >
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
