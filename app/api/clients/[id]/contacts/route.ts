import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import {
  createClientContact,
  listClientContacts,
  reissueContactCode,
} from "@/domain/clientContacts";
import { enforce } from "@/domain/permissions";

/**
 * A client's contacts, over HTTP.
 *
 * The same shell as every other route: resolve who is asking, ask
 * `permissions.enforce` whether they may touch *this* client, hand the work to
 * the domain layer, map a thrown error to a status. `client.issue_otp` is a
 * client-scoped action, so an account manager naming a client outside their own
 * roster is denied by scope -- which is what stops onboarding being the way to
 * reach another manager's client.
 *
 * The one-time code comes back in the response body. PRD §4 has no email
 * delivery in this build: the account manager reads the code off the screen and
 * passes it on. It is returned exactly once, and is never stored in plaintext
 * nor written to the audit trail.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/** GET /api/clients/:id/contacts -- who approves for this client. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "campaign.view", { clientId: params.id });

    const contacts = await listClientContacts(params.id);
    return NextResponse.json({ contacts });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/clients/:id/contacts -- create a contact, or re-issue a code.
 *
 * `{ name, email }` creates. `{ user_id }` re-issues for an existing contact,
 * for the case where the first code expired or never reached the person it was
 * read out to.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "client.issue_otp", { clientId: params.id });

    const body = (await request.json()) as Record<string, unknown>;

    const existingUserId = optionalString(body.user_id ?? body.userId);
    if (existingUserId) {
      // Re-issue. Scoped by the same `enforce` above, and `issueOtp` consumes
      // whatever code was outstanding so two are never live at once.
      const otp = await reissueContactCode(existingUserId, user.user_id);
      return NextResponse.json({ otp: presentable(otp) });
    }

    const created = await createClientContact(
      {
        clientId: params.id,
        name: asString(body.name),
        email: asString(body.email),
      },
      user.user_id,
    );

    return NextResponse.json(
      { contact: created.user, otp: presentable(created.otp) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * What of the code goes over the wire.
 *
 * The code itself and when it dies -- not the `otpId`, which the browser has no
 * use for and which would only give a screen something to key on that is not the
 * contact.
 */
function presentable(otp: { code: string; expiresAt: Date }) {
  return { code: otp.code, expires_at: otp.expiresAt.toISOString() };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
