"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, EmptyState } from "../../components/Page";

/**
 * A client's contact, and the one-time code that gets them in.
 *
 * The code is displayed, once, and never again. There is no email delivery in
 * this build (PRD §4), so the account manager reads it off this panel and passes
 * it on over whatever channel they already use with that client. It is stored
 * hashed, so nothing can show it a second time -- which is why the panel says so
 * plainly rather than leaving the manager to discover it by refreshing.
 */

type Contact = {
  user_id: string;
  name: string;
  email: string;
  status: string;
  last_login_at: string | null;
};

type IssuedCode = { code: string; expires_at: string };

export function ContactPanel({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [code, setCode] = useState<IssuedCode | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/clients/${clientId}/contacts`);
    if (!response.ok) {
      setContacts([]);
      return;
    }
    const body = (await response.json()) as { contacts: Contact[] };
    setContacts(body.contacts);
  }, [clientId]);

  useEffect(() => {
    // The displayed code belongs to the client it was issued for. Clearing on a
    // client change is what stops one client's code lingering on another's panel.
    setCode(null);
    setError(null);
    setContacts(null);
    void load();
  }, [load]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email }),
    });

    const body = (await response.json()) as {
      otp?: IssuedCode;
      error?: { message: string };
    };

    if (!response.ok) {
      setError(body.error?.message ?? "Could not create that contact.");
      setBusy(false);
      return;
    }

    setCode(body.otp!);
    setName("");
    setEmail("");
    setBusy(false);
    void load();
  }

  async function reissue(userId: string) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });

    const body = (await response.json()) as {
      otp?: IssuedCode;
      error?: { message: string };
    };

    if (!response.ok) {
      setError(body.error?.message ?? "Could not issue a code.");
      setBusy(false);
      return;
    }

    setCode(body.otp!);
    setBusy(false);
  }

  return (
    <Card title={`Contacts · ${clientName}`}>
      {code ? (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-sm font-medium text-emerald-900">
            One-time code — read this to your contact now.
          </p>
          <p className="my-2 font-mono text-3xl tracking-[0.3em] text-emerald-950">
            {code.code}
          </p>
          <p className="text-xs text-emerald-800">
            Expires {new Date(code.expires_at).toLocaleString()}. It is stored hashed, so
            this screen cannot show it again — issue a new one if it is lost.
          </p>
        </div>
      ) : null}

      {contacts === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : contacts.length === 0 ? (
        <EmptyState>No contact yet. Invite one below.</EmptyState>
      ) : (
        <ul className="mb-4 space-y-2">
          {contacts.map((contact) => (
            <li
              key={contact.user_id}
              className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium text-slate-900">{contact.name}</span>{" "}
                <span className="text-slate-500">{contact.email}</span>
                <span
                  className={
                    contact.status === "active"
                      ? "ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800"
                      : "ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
                  }
                >
                  {contact.status}
                </span>
              </span>
              <button
                type="button"
                onClick={() => reissue(contact.user_id)}
                disabled={busy}
                className="text-sm text-slate-700 underline underline-offset-4 hover:text-slate-900 disabled:opacity-50"
              >
                New code
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        One approver per client, enforced by the domain layer and by a unique
        index. The form is hidden once one exists rather than left to fail --
        offering an action the server will refuse is worse than not offering it.
      */}
      {contacts !== null && contacts.length === 0 ? (
        <form onSubmit={invite} className="space-y-3 border-t border-slate-200 pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Inviting…" : "Invite contact"}
          </button>
        </form>
      ) : null}

      {error && contacts !== null && contacts.length > 0 ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
