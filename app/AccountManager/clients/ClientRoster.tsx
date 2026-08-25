"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { RosterEntry } from "@/domain/clientRoster";

import { Card, EmptyState } from "../../components/Page";
import { ContactPanel } from "./ContactPanel";
import { CreateClientForm } from "./CreateClientForm";

export type MarketOption = { market_id: string; name: string; country_code: string };

/**
 * The roster, the create form, and the per-client contact panel.
 *
 * One client component rather than three, because creating a client and then
 * onboarding its contact is a single motion for the account manager: the newly
 * created client is selected straight away, so the code they must read out is on
 * the screen they are already looking at.
 */
export function ClientRoster({
  clients,
  markets,
}: {
  clients: RosterEntry[];
  markets: MarketOption[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  function afterCreate(client: RosterEntry) {
    setCreating(false);
    // Straight to the new client's contact panel -- onboarding is the next thing
    // the manager does, and the one-time code lives there.
    setSelected(client.client_id);
    // The roster is server-rendered, so the new row appears only once the router
    // cache is dropped.
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          {creating ? "Cancel" : "New client"}
        </button>
      </div>

      {creating ? (
        <Card title="New client">
          <CreateClientForm markets={markets} onCreated={afterCreate} />
        </Card>
      ) : null}

      {clients.length > 0 ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 pr-4 font-medium">Client</th>
                  <th className="pb-2 pr-4 font-medium">Industry</th>
                  <th className="pb-2 pr-4 font-medium">Markets</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 font-medium">Contacts</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.client_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-3 pr-4">
                      <span className="font-medium text-slate-900">{client.name}</span>
                      <span className="ml-2 text-xs text-slate-500">{client.client_id}</span>
                      {client.sensitive_sector ? (
                        // Derived from the industry, never set by hand. Shown
                        // because it decides whether every campaign this client
                        // runs carries mandatory compliance review.
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                          Sensitive
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-slate-600">{client.industry}</td>
                    <td className="py-3 pr-4 text-slate-600">
                      {client.markets.map((m) => m.country_code).join(", ") || "—"}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={
                          client.status === "active"
                            ? "rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800"
                            : "rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
                        }
                      >
                        {client.status}
                      </span>
                    </td>
                    <td className="py-3">
                      <button
                        type="button"
                        onClick={() =>
                          setSelected(selected === client.client_id ? null : client.client_id)
                        }
                        className="text-sm text-slate-700 underline underline-offset-4 hover:text-slate-900"
                      >
                        {selected === client.client_id ? "Hide" : "Manage"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {selected ? (
        <ContactPanel
          clientId={selected}
          clientName={clients.find((c) => c.client_id === selected)?.name ?? selected}
        />
      ) : null}

      {clients.length > 0 && !selected ? (
        <EmptyState>Choose Manage on a client to see or invite its contact.</EmptyState>
      ) : null}
    </div>
  );
}
