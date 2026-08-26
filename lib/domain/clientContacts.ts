import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { assignClientApprover } from "./clientContactInvariant";
import { issueOtp, type IssuedOtp } from "./otp";

/**
 * Onboarding a client contact.
 *
 * Three things have to happen together: a user row exists, that user is the
 * approver for exactly one client, and a one-time code is issued for them to
 * sign in with. Splitting them across the route would mean a half-onboarded
 * contact whenever one step failed -- an account with no client, or a client
 * whose approver can never sign in.
 *
 * The code is returned once, to be shown on screen. PRD §4 is explicit that
 * there is no email delivery in this build: the account manager reads the code
 * off the screen and passes it on over whatever channel they already use with
 * that client. So the code exists in the response and nowhere else -- it is
 * stored hashed, and the audit trail deliberately records that a code was
 * issued without recording the code.
 */

/** The contact's account is unusable until they redeem the code. */
const INVITED_STATUS = "invited";

export class ClientContactError extends Error {
  readonly code = "CLIENT_CONTACT_INVALID";
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(Object.values(issues)[0] ?? "That contact is not valid.");
    this.name = "ClientContactError";
    this.issues = issues;
  }
}

export type CreateClientContactInput = {
  clientId: string;
  name: string;
  email: string;
};

export type CreatedClientContact = {
  user: { user_id: string; name: string; email: string; status: string };
  /** Shown once, on screen. Never stored in plaintext and never logged. */
  otp: IssuedOtp;
};

/**
 * Create a contact for a client and issue their first one-time code.
 *
 * Refuses an email that already belongs to somebody. Re-using an existing
 * account would silently hand a second client's approval rights to a person who
 * already approves elsewhere -- which the single-approver invariant would then
 * reject halfway through, after the user row had already been altered.
 */
export async function createClientContact(
  input: CreateClientContactInput,
  createdById: string,
  db: Db = prisma,
): Promise<CreatedClientContact> {
  const clientId = input.clientId.trim();
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();

  const issues: Record<string, string> = {};
  if (!clientId) issues.client_id = "Name the client this contact approves for.";
  if (!name) issues.name = "A contact needs a name.";
  if (!email) issues.email = "A contact needs an email address.";
  // Deliberately shallow. The address is how the contact signs in, not something
  // that is mailed, so the only thing worth refusing is a value that could not
  // be typed back at the sign-in screen.
  else if (!email.includes("@")) issues.email = "That does not look like an email address.";

  if (Object.keys(issues).length > 0) throw new ClientContactError(issues);

  const client = await db.client.findUnique({ where: { client_id: clientId } });
  if (!client) throw new ClientContactError({ client_id: `No client ${clientId}.` });

  const taken = await db.user.findUnique({ where: { email } });
  if (taken) {
    throw new ClientContactError({ email: "Somebody already uses that email address." });
  }

  const user = await db.user.create({
    data: {
      name,
      email,
      user_type: "client_contact",
      // Invited, with no password. The account cannot hold a session until the
      // code is redeemed -- `createSession` refuses any status but active -- so
      // an onboarding that stops here leaves nothing usable behind.
      status: INVITED_STATUS,
      password_hash: null,
      must_change_password: false,
    },
    select: { user_id: true, name: true, email: true, status: true },
  });

  // P11.1: the account itself, not only the assignment and the code that follow.
  // Both of those write their own rows, and neither says a *person was created*
  // -- which is the fact an admin reviewing "who can reach this client" needs.
  // Never records the email as a credential, only as the identifier it is.
  await writeAudit(
    {
      entityType: "User",
      entityId: user.user_id,
      action: "created",
      performedById: createdById,
      details: { user_type: "client_contact", client_id: clientId, status: user.status },
    },
    db,
  );

  // Throws `SingleClientApproverError` if this user already approves elsewhere.
  // Unreachable for a user created two lines above, and called anyway: the
  // invariant belongs to the assignment, not to the order this function happens
  // to do things in.
  await assignClientApprover(
    { clientId, userId: user.user_id, performedById: createdById },
    db,
  );

  const otp = await issueOtp({ userId: user.user_id, byAccountManagerId: createdById }, db);

  return { user, otp };
}

/**
 * Issue a fresh code for a contact who already exists.
 *
 * The path for a code that expired, or that never reached the person it was
 * read out to. `issueOtp` consumes any outstanding code first, so re-issuing
 * cannot leave two live codes -- an older one, possibly already overheard,
 * still working precisely because the manager thought they had replaced it.
 */
export async function reissueContactCode(
  userId: string,
  byAccountManagerId: string,
  db: Db = prisma,
): Promise<IssuedOtp> {
  return issueOtp({ userId, byAccountManagerId }, db);
}

/** The contacts a client has, for the roster screen. */
export async function listClientContacts(clientId: string, db: Db = prisma) {
  const assignments = await db.clientAssignment.findMany({
    where: { client_id: clientId, role_on_client: "client_approver" },
    include: {
      user: {
        select: {
          user_id: true,
          name: true,
          email: true,
          status: true,
          last_login_at: true,
        },
      },
    },
  });

  return assignments.map((a) => a.user);
}
