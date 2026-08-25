"use client";

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
          <label htmlFor="client" className="mb-1 block text-sm font-medium text-slate-700">
            Client
          </label>
          <select
            id="client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 sm:w-auto"
          >
            {clients.map((c) => (
              <option key={c.client_id} value={c.client_id}>
                {c.name} ({c.client_id})
              </option>
            ))}
          </select>
          {client?.sensitive_sector ? (
            <p className="mt-1 text-xs text-amber-700">
              Sensitive sector — everything drafted for this client carries mandatory
              compliance review.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="title" className="mb-1 block text-sm font-medium text-slate-700">
            Title <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Left blank, the engine extracts one from the brief."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
          />
        </div>

        <div>
          <label htmlFor="brief" className="mb-1 block text-sm font-medium text-slate-700">
            Brief
          </label>
          <textarea
            id="brief"
            required
            rows={8}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="What the client asked for, in their words."
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
          disabled={busy || !clientId}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
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
  const tone = {
    DRAFT: "border-emerald-300 bg-emerald-50 text-emerald-900",
    FLAG: "border-amber-300 bg-amber-50 text-amber-900",
    REQUEST_INFO: "border-sky-300 bg-sky-50 text-sky-900",
    REFUSE_OVERRIDE: "border-red-300 bg-red-50 text-red-900",
  }[result.outcome];

  const headline = {
    DRAFT: "Drafted.",
    FLAG: "Flagged for review.",
    REQUEST_INFO: "More information needed.",
    REFUSE_OVERRIDE: "Refused — the brief asked to skip a guardrail.",
  }[result.outcome];

  return (
    <div className={`rounded-md border p-4 ${tone}`}>
      <p className="text-sm font-medium">{headline}</p>
      <p className="mt-1 text-sm">
        {result.campaign.title} · {result.counts.drafted} drafted,{" "}
        {result.counts.flagged} flagged, {result.counts.requestInfo} need info
      </p>
      {result.reason ? <p className="mt-2 text-sm">{result.reason}</p> : null}
      {result.clauseCode ? (
        <p className="mt-1 font-mono text-xs">Clause {result.clauseCode}</p>
      ) : null}
    </div>
  );
}
