"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { Page } from "@/domain/pagination";

/**
 * Page controls, driven by the query string.
 *
 * The page lives in the URL rather than in component state, deliberately: it
 * makes page 3 of a filtered roster a link somebody can send, survives a
 * refresh, and keeps the server component as the single source of what is on
 * screen. Holding it in `useState` would mean the server rendered page 1 while
 * the browser believed it was on page 3.
 */
export function Pagination({ page }: { page: Page<unknown> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function goTo(next: number) {
    const query = new URLSearchParams(params.toString());
    // Page 1 is the default, so it is dropped rather than written -- a URL
    // that says `?page=1` is noise in a shared link.
    if (next <= 1) query.delete("page");
    else query.set("page", String(next));

    const qs = query.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.page * page.pageSize, page.total);

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-edge pt-4">
      <p className="text-sm text-body">
        {page.total === 0 ? (
          "No matches"
        ) : (
          <>
            <span className="font-semibold text-heading">
              {first}–{last}
            </span>{" "}
            of {page.total}
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => goTo(page.page - 1)}
          disabled={!page.hasPrevious}
          className="skip-btn skip-btn-secondary px-4 py-1.5 text-xs"
        >
          Previous
        </button>
        <span className="px-1 text-sm text-body">
          {page.page} / {page.totalPages}
        </span>
        <button
          type="button"
          onClick={() => goTo(page.page + 1)}
          disabled={!page.hasNext}
          className="skip-btn skip-btn-secondary px-4 py-1.5 text-xs"
        >
          Next
        </button>
      </div>
    </div>
  );
}
