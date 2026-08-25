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
        <div className="mb-4 rounded-xl border-2 border-amber-brand bg-amber-brand/10 p-5">
          <p className="text-sm font-semibold text-heading">
            One-time code — read this to your contact now.
          </p>
          <p className="my-3 font-mono text-4xl font-bold tracking-[0.3em] text-heading">
            {code.code}
          </p>
          <p className="text-xs text-body">
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
              className="flex items-center justify-between rounded-xl border border-edge px-4 py-3 text-sm"
            >
              <span>
                <span className="font-semibold text-heading">{contact.name}</span>{" "}
                <span className="text-body/70">{contact.email}</span>
                <span
                  className={
                    contact.status === "active"
                      ? "ml-2 rounded-md border border-ok/20 bg-ok-bg px-2 py-0.5 text-xs font-semibold text-ok"
                      : "ml-2 rounded-md border border-info/20 bg-info-bg px-2 py-0.5 text-xs font-semibold text-info"
                  }
                >
                  {contact.status}
                </span>
              </span>
              <button
                type="button"
                onClick={() => reissue(contact.user_id)}
                disabled={busy}
                className="text-sm font-semibold text-heading underline underline-offset-4 transition-colors hover:text-flag disabled:opacity-50"
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
        <form onSubmit={invite} className="space-y-3 border-t border-edge pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="skip-label">Name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="skip-input"
              />
            </div>
            <div>
              <label className="skip-label">Email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="skip-input"
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="skip-btn skip-btn-primary"
          >
            {busy ? "Inviting…" : "Invite contact"}
          </button>
        </form>
      ) : null}

      {error && contacts !== null && contacts.length > 0 ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
