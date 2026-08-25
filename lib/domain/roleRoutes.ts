import type { EffectiveRole } from "./accessScope";

/**
 * Where each role lives in the app, and what its nav offers.
 *
 * In the domain layer rather than beside the components because two very
 * different callers need the same answer: the middleware deciding where to send
 * a signed-in visitor, and the nav deciding what to draw. Two copies of this
 * map would drift, and the failure would be a role whose nav offers a link the
 * middleware then bounces them out of -- a loop the user cannot escape.
 *
 * Pure data. No Next, no React, so `middleware.ts` can import it without
 * pulling the presentation layer into the edge bundle.
 */

/** The five role home routes. Segment names match the folders under `app/`. */
export const ROLE_HOME: Record<EffectiveRole, string> = {
  account_manager: "/AccountManager",
  content_lead: "/ContentLead",
  content_creator: "/Creator",
  client_contact: "/Client",
  agency_admin: "/Admin",
};

/** Every role-owned segment, for deciding whether a path belongs to a role. */
export const ROLE_SEGMENTS: readonly string[] = Object.values(ROLE_HOME);

/** A single entry in a role's sidebar. */
export type NavItem = {
  href: string;
  label: string;
};

/**
 * The nav for a role.
 *
 * Deliberately hand-written per role rather than derived from `actionsFor`. A
 * capability is not a page -- `approval.internal` and `approval.revoke` are one
 * screen, and `campaign.view` is three. Deriving links from capabilities would
 * produce a nav that grows a dead link every time an action is added.
 *
 * Hiding a link is presentation, never protection. Every page behind these
 * still calls `enforce`, because a link the nav omits is one a typed URL
 * reaches.
 */
export const ROLE_NAV: Record<EffectiveRole, readonly NavItem[]> = {
  account_manager: [
    { href: "/AccountManager", label: "Overview" },
    { href: "/AccountManager/clients", label: "Clients" },
    { href: "/AccountManager/briefs", label: "Briefs" },
    { href: "/AccountManager/queue", label: "Queue" },
  ],
  content_lead: [
    { href: "/ContentLead", label: "Overview" },
    { href: "/ContentLead/review", label: "Review" },
  ],
  content_creator: [
    { href: "/Creator", label: "Overview" },
    { href: "/Creator/assignments", label: "Assignments" },
  ],
  client_contact: [
    { href: "/Client", label: "Overview" },
    { href: "/Client/approvals", label: "Approvals" },
    { href: "/Client/requests", label: "Requests" },
  ],
  agency_admin: [
    { href: "/Admin", label: "Overview" },
    { href: "/Admin/governance", label: "Governance" },
  ],
};

/** Human-readable role name, for the header. */
export const ROLE_LABEL: Record<EffectiveRole, string> = {
  account_manager: "Account Manager",
  content_lead: "Content Lead",
  content_creator: "Content Creator",
  client_contact: "Client",
  agency_admin: "Agency Admin",
};

/**
 * Whether a path sits inside a role's own segment.
 *
 * Compares segment boundaries, not a bare `startsWith`: `/ClientPortal` starts
 * with `/Client` but is not the client's area, and a role check that matched it
 * would hand a contact a page belonging to nobody.
 */
export function isWithinRoleArea(pathname: string, role: EffectiveRole): boolean {
  const home = ROLE_HOME[role];
  return pathname === home || pathname.startsWith(`${home}/`);
}

/**
 * Which role owns this path, if any.
 *
 * Returns null for a shared path (sign-in, the password screen, the root), which
 * is what tells the middleware not to apply a role check at all.
 */
export function roleForPath(pathname: string): EffectiveRole | null {
  for (const role of Object.keys(ROLE_HOME) as EffectiveRole[]) {
    if (isWithinRoleArea(pathname, role)) return role;
  }
  return null;
}
