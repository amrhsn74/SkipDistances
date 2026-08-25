import { describe, it, expect } from "vitest";

import type { EffectiveRole } from "./accessScope";
import {
  ROLE_HOME,
  ROLE_LABEL,
  ROLE_NAV,
  isWithinRoleArea,
  roleForPath,
} from "./roleRoutes";

const ROLES: EffectiveRole[] = [
  "account_manager",
  "content_lead",
  "content_creator",
  "client_contact",
  "agency_admin",
];

describe("ROLE_HOME", () => {
  it("covers every role", () => {
    for (const role of ROLES) {
      expect(ROLE_HOME[role]).toMatch(/^\/[A-Za-z]+$/);
    }
  });

  it("gives each role a distinct home", () => {
    const homes = ROLES.map((r) => ROLE_HOME[r]);
    expect(new Set(homes).size).toBe(homes.length);
  });
});

describe("isWithinRoleArea", () => {
  it("matches the home itself and paths beneath it", () => {
    expect(isWithinRoleArea("/Client", "client_contact")).toBe(true);
    expect(isWithinRoleArea("/Client/approvals", "client_contact")).toBe(true);
  });

  it("does not match another role's area", () => {
    expect(isWithinRoleArea("/Admin", "client_contact")).toBe(false);
  });

  /**
   * The reason this compares segments rather than calling `startsWith` on the
   * bare prefix. `/ClientPortal` is not the client's area, and a role check that
   * accepted it would hand a contact a page belonging to nobody.
   */
  it("does not match a path that merely shares the prefix", () => {
    expect(isWithinRoleArea("/ClientPortal", "client_contact")).toBe(false);
    expect(isWithinRoleArea("/Clients", "client_contact")).toBe(false);
  });
});

describe("roleForPath", () => {
  it("names the owning role", () => {
    expect(roleForPath("/AccountManager/clients")).toBe("account_manager");
    expect(roleForPath("/Admin")).toBe("agency_admin");
  });

  it("returns null for shared paths", () => {
    expect(roleForPath("/signin")).toBeNull();
    expect(roleForPath("/")).toBeNull();
    expect(roleForPath("/password")).toBeNull();
  });
});

describe("ROLE_NAV", () => {
  it("gives every role a nav that starts at its own home", () => {
    for (const role of ROLES) {
      const nav = ROLE_NAV[role];
      expect(nav.length).toBeGreaterThan(0);
      expect(nav[0].href).toBe(ROLE_HOME[role]);
    }
  });

  /**
   * A link outside the role's own area would be bounced by the middleware, so
   * the nav would offer a dead end. This is the assertion that keeps the two
   * halves of `roleRoutes` honest with each other.
   */
  it("never links outside the role's own area", () => {
    for (const role of ROLES) {
      for (const item of ROLE_NAV[role]) {
        expect(isWithinRoleArea(item.href, role)).toBe(true);
      }
    }
  });

  it("labels every role", () => {
    for (const role of ROLES) {
      expect(ROLE_LABEL[role]).toBeTruthy();
    }
  });
});
