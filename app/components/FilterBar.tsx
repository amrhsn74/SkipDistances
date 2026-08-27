"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * A filter row, driven by the query string.
 *
 * Same reasoning as `Pagination`: filters in the URL make a filtered view
 * shareable and refresh-proof, and keep the server render authoritative.
 *
 * Changing any filter resets to page 1. Without that, narrowing a 150-row list
 * while sitting on page 6 lands the reader on an empty page and looks like the
 * filter returned nothing.
 */

export type SelectFilter = {
  name: string;
  label: string;
  options: { value: string; label: string }[];
};

export function FilterBar({
  searchPlaceholder = "Search…",
  selects = [],
  toggles = [],
  flush = false,
}: {
  searchPlaceholder?: string;
  selects?: SelectFilter[];
  toggles?: { name: string; label: string }[];
  /** Drop the bottom margin, where the bar is the last thing in its card. */
  flush?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [search, setSearch] = useState(params.get("q") ?? "");

  function apply(mutate: (query: URLSearchParams) => void) {
    const query = new URLSearchParams(params.toString());
    mutate(query);
    // Any change to what is being filtered starts again at the first page.
    query.delete("page");

    const qs = query.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function setParam(name: string, value: string) {
    apply((query) => {
      // An empty value means "no filter", and is removed rather than written as
      // an empty string -- `?status=` in a shared URL reads as a real filter.
      if (value) query.set(name, value);
      else query.delete(name);
    });
  }

  const active = [...selects.map((s) => s.name), ...toggles.map((t) => t.name), "q"].some((n) =>
    params.get(n),
  );

  return (
    <div className={`flex flex-wrap items-end gap-3 ${flush ? "" : "mb-4"}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setParam("q", search.trim());
        }}
        className="flex items-end gap-2"
      >
        <div>
          <label htmlFor="filter-q" className="skip-label">
            Search
          </label>
          <input
            id="filter-q"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="skip-input w-56"
          />
        </div>
        <button type="submit" className="skip-btn skip-btn-secondary px-4 py-2">
          Go
        </button>
      </form>

      {selects.map((select) => (
        <div key={select.name}>
          <label htmlFor={`filter-${select.name}`} className="skip-label">
            {select.label}
          </label>
          <select
            id={`filter-${select.name}`}
            value={params.get(select.name) ?? ""}
            onChange={(e) => setParam(select.name, e.target.value)}
            className="skip-input w-44"
          >
            <option value="">Any</option>
            {select.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      {toggles.map((toggle) => {
        const on = params.get(toggle.name) === "1";
        return (
          <button
            key={toggle.name}
            type="button"
            onClick={() => setParam(toggle.name, on ? "" : "1")}
            aria-pressed={on}
            className={
              on
                ? "skip-btn bg-ink px-4 py-2 text-white"
                : "skip-btn skip-btn-secondary px-4 py-2"
            }
          >
            {toggle.label}
          </button>
        );
      })}

      {active ? (
        <button
          type="button"
          onClick={() => {
            setSearch("");
            router.push(pathname);
          }}
          className="pb-2 text-sm text-body underline underline-offset-4 transition-colors hover:text-heading"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
