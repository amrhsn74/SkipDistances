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
  /**
   * Which glyph the sidebar draws. A name, not an SVG: this module is pure and
   * must not import anything that renders, so the mapping to markup lives in
   * the component and the vocabulary lives here.
   */
  icon: NavIcon;
};

export type NavIcon =
  | "overview"
  | "clients"
  | "briefs"
  | "queue"
  | "calendar"
  | "review"
  | "assignments"
  | "approvals"
  | "requests"
  | "guide"
  | "governance"
  | "chat"
  | "audit"
  | "analytics";

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
    { href: "/AccountManager", label: "Overview", icon: "overview" },
    { href: "/AccountManager/clients", label: "Clients", icon: "clients" },
    { href: "/AccountManager/queue", label: "Briefs", icon: "briefs" },
    // The account manager is a client's internal reviewer by default, so the
    // review queue is theirs in the common case -- the content lead's identical
    // entry below is the per-client override, not the norm.
    { href: "/AccountManager/review", label: "Review", icon: "review" },
    // The front door clients come in through. Its own entry rather than a tab
    // on the briefs queue: a request is not a brief until someone converts it.
    { href: "/AccountManager/requests", label: "Requests", icon: "requests" },
    { href: "/AccountManager/calendar", label: "Calendar", icon: "calendar" },
    { href: "/AccountManager/analytics", label: "Analytics", icon: "analytics" },
  ],
  content_lead: [
    { href: "/ContentLead", label: "Overview", icon: "overview" },
    // The lead prompts the engine as a creator does, and dispatches the result.
    { href: "/ContentLead/chat", label: "Chat", icon: "chat" },
    { href: "/ContentLead/review", label: "Review", icon: "review" },
  ],
  content_creator: [
    { href: "/Creator", label: "Overview", icon: "overview" },
    // First, not last: since Phase 14 this is where a creator's work starts.
    { href: "/Creator/chat", label: "Chat", icon: "chat" },
    { href: "/Creator/assignments", label: "Assignments", icon: "assignments" },
    // The agency handbook only. A client's own brand guide is scoped to a
    // client, so it belongs on the chat thread where one has been chosen --
    // not in a nav page listing every assigned client's guide at once.
    { href: "/Creator/guidelines", label: "Agency standards", icon: "guide" },
  ],
  client_contact: [
    { href: "/Client", label: "Overview", icon: "overview" },
    { href: "/Client/approvals", label: "Approvals", icon: "approvals" },
    { href: "/Client/requests", label: "Requests", icon: "requests" },
    // The second thing a client approves, and the one with the wider reach: a
    // guide version changes what every future draft is grounded in.
    { href: "/Client/brand-guide", label: "Brand guide", icon: "guide" },
    { href: "/Client/analytics", label: "Analytics", icon: "analytics" },
  ],
  agency_admin: [
    { href: "/Admin", label: "Overview", icon: "overview" },
    { href: "/Admin/governance", label: "Governance", icon: "governance" },
    // Who works on what. The PRD gives the admin no user-management screen, so
    // this is the client roster with its seats editable in place.
    { href: "/Admin/roles", label: "Roles", icon: "clients" },
    { href: "/Admin/audit", label: "Audit trail", icon: "audit" },
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
