import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { effectiveRole } from "@/domain/accessScope";
import { createClient, listClients } from "@/domain/clientRoster";
import { PermissionDeniedError, enforce, roleCan } from "@/domain/permissions";

/**
 * The client roster over HTTP.
 *
 * No business logic lives here. The handler resolves who is asking, asks
 * `permissions.enforce` whether they may, hands the work to `clientRoster`, and
 * maps a thrown error to a status. Scoping, validation, id allocation and the
 * sensitive-sector derivation are all in the domain layer, where they are
 * unit-tested without a server.
 */

// Every response depends on the session cookie, so nothing here is cacheable.
export const dynamic = "force-dynamic";

/** GET /api/clients -- the roster, scoped to what the caller may see. */
export async function GET() {
  try {
    const user = await requireUser();

    // `roleCan`, not `enforce`. `campaign.view` is a client-scoped action, and a
    // list endpoint has no single client to name -- `enforce` would deny every
    // caller with `missing_client_context`. So the capability is checked here
    // and *which* clients is left to `listClients`, which scopes through
    // `clientScopeWhere`. A role that may see no client still gets an empty
    // list rather than the roster, because that filter is `{ in: [] }`.
    const role = await effectiveRole(user);
    if (!roleCan(role, "campaign.view")) {
      throw new PermissionDeniedError("campaign.view", role, "role_lacks_capability");
    }

    const clients = await listClients(user);
    return NextResponse.json({ clients });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/clients -- create a client, including the market(s) they operate in. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    await enforce(user, "client.create");

    const body = (await request.json()) as Record<string, unknown>;

    const client = await createClient(
      {
        name: asString(body.name),
        industry: asString(body.industry),
        // Accepts `market_ids` or `marketIds` -- the wire uses the schema's
        // snake_case, the domain layer uses camelCase, and a form posting either
        // should not fail on a naming preference.
        marketIds: asStringArray(body.market_ids ?? body.marketIds),
        status: optionalString(body.status),
        tier: optionalString(body.tier) ?? null,
        channels: asStringArray(body.channels),
        // Omitted rather than null when absent, so `createClient` defaults it to
        // the creating account manager instead of leaving the client unowned.
        ...(hasKey(body, "account_manager_id") || hasKey(body, "accountManagerId")
          ? {
              accountManagerId:
                optionalString(body.account_manager_id ?? body.accountManagerId) ?? null,
            }
          : {}),
      },
      user.user_id,
    );

    return NextResponse.json({ client }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Body coercion, kept deliberately dumb.
 *
 * A wrong type becomes an empty value rather than throwing, so the caller gets
 * `ClientValidationError`'s field-keyed message ("A client needs a name")
 * instead of a 500 or a generic parse error. The domain layer is what decides
 * whether a value is acceptable; this only decides what type reached it.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function hasKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}
