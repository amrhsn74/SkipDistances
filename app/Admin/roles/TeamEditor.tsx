"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "../../components/Page";

/**
 * Who works on one client, edited in place.
 *
 * The PRD is explicit that there is no dedicated user-management screen -- "the
 * Admin edits the fields directly on a client record" -- so this is a row on the
 * roster that expands, not a separate page per person.
 *
 * Every control here writes through `roleAssignment`, which re-checks admin
 * rights and the single-client-approver invariant on the server regardless of
 * what this offers. The dropdowns are convenience; they are not the guard.
 */

export type Person = { user_id: string; name: string; email: string };

export type Team = {
  client_id: string;
  client_name: string;
  account_manager: Person | null;
  content_leads: Person[];
  content_creators: Person[];
  client_approvers: Person[];
};

const ROLE_LABEL: Record<string, string> = {
  content_lead: "Content lead",
  content_creator: "Creator",
  client_approver: "Client contact",
};

export function TeamEditor({
  team,
  staff,
}: {
  team: Team;
  /** Every staff user, for the pickers. */
  staff: Person[];
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/clients/${team.client_id}/team`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const json = await response.json();
        setError(json?.error?.message ?? "That change did not go through.");
        return;
      }
      router.refresh();
    } catch {
      setError("That change did not go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-edge px-4 py-4">
      <Seat
        label="Account manager"
        held={team.account_manager ? [team.account_manager] : []}
        staff={staff}
        busy={busy}
        // Null is a real state, not a refusal: CL-109 is seeded with no manager.
        allowEmpty
        onAdd={(userId) => send("POST", { role: "account_manager", user_id: userId })}
        onClear={() => send("POST", { role: "account_manager", user_id: null })}
      />

      {(["content_lead", "content_creator", "client_approver"] as const).map((role) => (
        <Seat
          key={role}
          label={ROLE_LABEL[role]}
          held={
            role === "content_lead"
              ? team.content_leads
              : role === "content_creator"
                ? team.content_creators
                : team.client_approvers
          }
          staff={staff}
          busy={busy}
          multiple={role !== "client_approver"}
          onAdd={(userId) => send("POST", { role, user_id: userId })}
          onRemove={(userId) => send("DELETE", { role, user_id: userId })}
        />
      ))}

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Seat({
  label,
  held,
  staff,
  busy,
  multiple,
  allowEmpty,
  onAdd,
  onRemove,
  onClear,
}: {
  label: string;
  held: Person[];
  staff: Person[];
  busy: boolean;
  multiple?: boolean;
  allowEmpty?: boolean;
  onAdd: (userId: string) => void;
  onRemove?: (userId: string) => void;
  onClear?: () => void;
}) {
  const [picked, setPicked] = useState("");

  // A seat that holds one person and already has them offers no picker: the way
  // to change it is to clear or remove first, which keeps the resulting audit
  // trail two legible acts rather than one ambiguous swap.
  const canAdd = multiple || held.length === 0;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-32 shrink-0 text-xs font-semibold text-heading">{label}</span>

      <div className="flex flex-wrap items-center gap-2">
        {held.length === 0 ? (
          <span className="text-xs text-body">Nobody</span>
        ) : (
          held.map((person) => (
            <span key={person.user_id} className="flex items-center gap-1">
              <Badge>{person.name}</Badge>
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(person.user_id)}
                  disabled={busy}
                  className="text-xs text-body hover:text-danger disabled:opacity-50"
                  aria-label={`Remove ${person.name}`}
                >
                  ×
                </button>
              ) : null}
              {allowEmpty && onClear ? (
                <button
                  type="button"
                  onClick={onClear}
                  disabled={busy}
                  className="text-xs text-body hover:text-danger disabled:opacity-50"
                  aria-label={`Clear ${label}`}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>

      {canAdd ? (
        <div className="flex items-center gap-2">
          <select
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            disabled={busy}
            className="rounded-xl border border-edge bg-surface px-2 py-1 text-xs outline-none focus:border-amber-brand disabled:opacity-50"
            aria-label={`Assign ${label}`}
          >
            <option value="">Add…</option>
            {staff
              .filter((person) => !held.some((h) => h.user_id === person.user_id))
              .map((person) => (
                <option key={person.user_id} value={person.user_id}>
                  {person.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (picked) {
                onAdd(picked);
                setPicked("");
              }
            }}
            disabled={busy || picked === ""}
            className="rounded-lg bg-amber-brand px-3 py-1 text-xs font-semibold text-ink transition hover:opacity-90 disabled:opacity-50"
          >
            Assign
          </button>
        </div>
      ) : null}
    </div>
  );
}
