"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type ClientOption = { client_id: string; name: string; sensitive_sector: boolean };

type IntakeOutcome = "DRAFT" | "FLAG" | "REQUEST_INFO" | "REFUSE_OVERRIDE";

type IntakeResult = {
  campaign: { campaign_id: string; title: string; status: string };
  outcome: IntakeOutcome;
  clauseCode: string | null;
  reason: string | null;
  counts: { drafted: number; flagged: number; requestInfo: number };
};

/**
 * The brief intake form.
 *
 * Every one of the engine's four outcomes is a *successful* submission, and the
 * form shows them all the same way: the campaign row exists whatever the engine
 * decided, and the account manager revises and re-runs that same campaign. A
 * form that treated FLAG as an error would throw away the row and turn "fix the
 * one issue" into "retype the brief".
 *
 * The submission can take a while -- the engine makes several Gemini calls -- so
 * the button says so rather than appearing to have missed the click.
 */
export function BriefIntake({ clients }: { clients: ClientOption[] }) {
  const router = useRouter();

  const [clientId, setClientId] = useState(clients[0]?.client_id ?? "");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const client = clients.find((c) => c.client_id === clientId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    const response = await fetch("/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        raw_brief_text: brief,
        title: title || null,
      }),
    });

    const body = (await response.json()) as IntakeResult & {
      error?: { message: string };
    };

    if (!response.ok) {
      setError(body.error?.message ?? "The brief could not be submitted.");
      setBusy(false);
      return;
    }

    setResult(body);
    setBrief("");
    setTitle("");
    setBusy(false);
    // The queue below is server-rendered, so the new row appears only once the
    // router cache is dropped.
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {result ? <Outcome result={result} /> : null}

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="client" className="skip-label">
            Client
          </label>
          <select
            id="client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="skip-input sm:w-auto"
          >
            {clients.map((c) => (
              <option key={c.client_id} value={c.client_id}>
                {c.name} ({c.client_id})
              </option>
            ))}
          </select>
          {client?.sensitive_sector ? (
            <p className="mt-1 text-xs text-flag">
              Sensitive sector — everything drafted for this client carries mandatory
              compliance review.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="title" className="skip-label">
            Title <span className="font-normal text-body/70">(optional)</span>
          </label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Left blank, the engine extracts one from the brief."
            className="skip-input"
          />
        </div>

        <div>
          <label htmlFor="brief" className="skip-label">
            Brief
          </label>
          <textarea
            id="brief"
            required
            rows={8}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="What the client asked for, in their words."
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
          disabled={busy || !clientId}
          className="skip-btn skip-btn-primary"
        >
          {busy ? "Running the brief through the engine…" : "Submit brief"}
        </button>
      </form>
    </div>
  );
}

/**
 * What the engine decided.
 *
 * Every outcome cites its clause where it has one -- that citation is the point
 * of the guardrail, and a screen that dropped it would leave a manager with a
 * refusal and no way to see which rule produced it.
 */
function Outcome({ result }: { result: IntakeResult }) {
  // Each outcome gets the same tone its badge would. FLAG is deliberately not
  // amber: amber is the brand chrome now, and a flag that matched the header
  // would stop reading as something gone wrong.
  const tone = {
    DRAFT: "border-ok/30 bg-ok-bg text-ok",
    FLAG: "border-flag/30 bg-flag-bg text-flag",
    REQUEST_INFO: "border-info/30 bg-info-bg text-info",
    REFUSE_OVERRIDE: "border-danger/30 bg-danger-bg text-danger",
  }[result.outcome];

  const headline = {
    DRAFT: "Drafted.",
    FLAG: "Flagged for review.",
    REQUEST_INFO: "More information needed.",
    REFUSE_OVERRIDE: "Refused — the brief asked to skip a guardrail.",
  }[result.outcome];

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <p className="text-sm font-medium">{headline}</p>
      <p className="mt-1 text-sm">
        {result.campaign.title} · {result.counts.drafted} drafted,{" "}
        {result.counts.flagged} flagged, {result.counts.requestInfo} need info
      </p>
      {result.reason ? <p className="mt-2 text-sm">{result.reason}</p> : null}
      {result.clauseCode ? (
        <p className="mt-1 font-mono text-xs">Clause {result.clauseCode}</p>
      ) : null}
      <Link
        href="/AccountManager/queue"
        className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
      >
        See it in the queue
      </Link>
    </div>
  );
}
