"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { RosterEntry } from "@/domain/clientRoster";

export type MarketOption = { market_id: string; name: string; country_code: string };



/**
 * The client creation form.
 *
 * Markets are checkboxes over the seeded `Market` rows, not a hardcoded pair.
 * PRD §6 requires at least one, and the domain layer refuses a client with none
 * -- so the button disables rather than posting something `createClient` will
 * throw on. Both halves matter: the disabled button is a courtesy, the server
 * check is the rule.
 *
 * `sensitive_sector` is deliberately absent. It is derived from the industry by
 * the same function the seed and the engine call, and a field a form can set is
 * a field a form can get wrong -- this one decides whether every campaign the
 * client ever runs carries mandatory compliance review.
 */

/** Channels the agency actually posts to. Free text would not group anything. */
const CHANNELS = ["instagram", "facebook", "tiktok", "linkedin", "x"];

const TIERS = ["standard", "premium", "enterprise"];

export function CreateClientForm({ markets }: { markets: MarketOption[] }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [tier, setTier] = useState("");
  const [marketIds, setMarketIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(list: string[], set: (next: string[]) => void, value: string) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setIssues({});

    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        industry,
        market_ids: marketIds,
        channels,
        tier: tier || null,
      }),
    });

    const body = (await response.json()) as {
      client?: RosterEntry;
      error?: { message: string; issues?: Record<string, string> };
    };

    if (!response.ok) {
      // Field-keyed issues from `ClientValidationError`, shown against the field
      // rather than as one line at the top -- the domain layer already knows
      // which field was wrong, and throwing that away makes the form guesswork.
      setIssues(body.error?.issues ?? {});
      setError(body.error?.message ?? "Could not create that client.");
      setBusy(false);
      return;
    }

    // Straight to the new client's page -- onboarding its contact is the next
    // thing the manager does, and that is where the one-time code lives.
    router.push(`/AccountManager/clients/${body.client!.client_id}`);
    // The roster is server-rendered, so the new row appears only once the
    // router cache is dropped.
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" issue={issues.name}>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="skip-input"
          />
        </Field>

        <Field
          label="Industry"
          issue={issues.industry}
          hint="Decides whether this client's work needs compliance review."
        >
          <input
            required
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="skip-input"
          />
        </Field>
      </div>

      <Field label="Markets" issue={issues.marketIds ?? issues.market_ids} hint="At least one.">
        <div className="flex flex-wrap gap-3">
          {markets.map((market) => (
            <label
              key={market.market_id}
              className="flex cursor-pointer items-center gap-2 rounded-pill border-2 border-edge px-4 py-2 text-sm transition-colors hover:border-ink"
            >
              <input
                type="checkbox"
                checked={marketIds.includes(market.market_id)}
                onChange={() => toggle(marketIds, setMarketIds, market.market_id)}
              />
              {market.name} ({market.country_code})
            </label>
          ))}
        </div>
      </Field>

      <Field label="Channels">
        <div className="flex flex-wrap gap-3">
          {CHANNELS.map((channel) => (
            <label
              key={channel}
              className="flex cursor-pointer items-center gap-2 rounded-pill border-2 border-edge px-4 py-2 text-sm capitalize transition-colors hover:border-ink"
            >
              <input
                type="checkbox"
                checked={channels.includes(channel)}
                onChange={() => toggle(channels, setChannels, channel)}
              />
              {channel}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Tier" issue={issues.tier}>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="skip-input sm:w-auto"
        >
          <option value="">Not set</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || marketIds.length === 0}
        className="skip-btn skip-btn-primary"
      >
        {busy ? "Creating…" : "Create client"}
      </button>
    </form>
  );
}

function Field({
  label,
  hint,
  issue,
  children,
}: {
  label: string;
  hint?: string;
  issue?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="skip-label">{label}</label>
      {children}
      {issue ? (
        <p className="mt-1 text-xs text-danger">{issue}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-body/70">{hint}</p>
      ) : null}
    </div>
  );
}
