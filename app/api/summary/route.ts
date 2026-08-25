import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { visibleClients } from "@/domain/accessScope";
import { operationalSummary } from "@/domain/summary";

/**
 * The counts panel, over HTTP.
 *
 * PRD §6 makes this the source of truth for what is waiting -- reminders are out
 * of scope, so anything not surfaced here is not surfaced at all.
 *
 * There is deliberately no `enforce` call, for the same reason as the
 * `PostRequest` queue: every client-scoped capability needs a `clientId` to
 * check against, and a cross-client rollup has none by definition.
 * `visibleClients` *is* the check here -- it returns exactly the clients this
 * session may see, and an empty list for a user with none, so the summary cannot
 * widen past the caller's scope whatever their role.
 *
 * That scope is passed down as a parameter rather than decided inside
 * `operationalSummary`, which is what lets `P11.5` reuse the identical query
 * unscoped for the Admin's cross-client view instead of growing a second one.
 */

// Reads the session cookie. Never cached.
export const dynamic = "force-dynamic";

/**
 * GET /api/summary -- pipeline counts by client, status and market, plus the
 * occasions coming up across the markets those clients operate in.
 *
 * `?window_days=` widens or narrows the occasion horizon (default 90).
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();

    const scope = await visibleClients(user);

    const windowDays = parseWindow(new URL(request.url).searchParams.get("window_days"));

    const summary = await operationalSummary(scope.all ? "all" : scope.clientIds, {
      occasionWindowDays: windowDays,
    });

    return NextResponse.json({
      ...summary,
      // Useful to a UI deciding whether to show a client column at all, and it
      // makes the response self-describing about which view produced it.
      scope: { role: scope.role, all_clients: scope.all === true },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * A sane window, or the default.
 *
 * Clamped rather than trusted: `window_days=999999` would resolve occasions over
 * a range with no seeded `OccasionDate` rows beyond it, and a negative value
 * would ask `resolveOccasions` for a backwards range. Neither is worth an error
 * response -- the caller gets a usable panel either way.
 */
function parseWindow(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), 365);
}
