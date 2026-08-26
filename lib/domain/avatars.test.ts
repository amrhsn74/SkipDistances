import { describe, it, expect } from "vitest";

import { AVATARS, avatarFor, initialsFor, type AvatarRole } from "./avatars";

/**
 * Which picture stands for a person.
 *
 * Two requirements, and they pull in different directions. The picture must be
 * **role-accurate** -- the artwork is one face per role, so putting the admin's
 * portrait beside a creator would mislead a reader who had learned to recognise
 * it. And it must be **stable** -- the same person on two screens, or two
 * renders of one screen, must look the same, or the avatar identifies nobody.
 *
 * The rest is a hash doing what a hash does, so what is asserted around it is
 * the contract: always a real file, never an out-of-range index, and no crash on
 * the nullable ids the schema genuinely produces.
 */

const ROLES: AvatarRole[] = [
  "account_manager",
  "content_lead",
  "content_creator",
  "client_contact",
  "agency_admin",
];

describe("role accuracy", () => {
  it("gives each single-face role its own picture", () => {
    // The whole point of keying on role rather than hashing identity: these
    // three are distinct people doing distinct jobs, and the face says which.
    const am = avatarFor("any-id", "account_manager");
    const admin = avatarFor("any-id", "agency_admin");
    const lead = avatarFor("any-id", "content_lead");

    expect(new Set([am, admin, lead]).size).toBe(3);
  });

  it("gives a single-face role the same picture whoever holds it", () => {
    // Not a hash for these roles -- every account manager wears the same face,
    // which is what makes the initials beside it load-bearing.
    expect(avatarFor("user-a", "account_manager")).toBe(avatarFor("user-b", "account_manager"));
  });

  it("uses both creator faces, stably per person", () => {
    const picks = new Set(
      Array.from({ length: 60 }, (_, i) => avatarFor(`creator-${i}`, "content_creator")),
    );

    // Two files exist for this role, so both should be in play -- a constant
    // here would pass every other assertion while wasting half the artwork.
    expect(picks.size).toBe(2);
    expect(avatarFor("creator-7", "content_creator")).toBe(
      avatarFor("creator-7", "content_creator"),
    );
  });

  it("always returns a file that exists, for every role", () => {
    for (const role of ROLES) {
      for (let i = 0; i < 100; i += 1) {
        expect(AVATARS).toContain(avatarFor(`user-${i}`, role));
      }
    }
  });
});

describe("stability", () => {
  it("gives the same user the same picture every time", () => {
    const id = "cmt8gc44m000z80rd6yfh0p7g";

    expect(avatarFor(id)).toBe(avatarFor(id));
    expect(avatarFor(id, "content_creator")).toBe(avatarFor(id, "content_creator"));
  });

  it("never returns an out-of-range pick, with or without a role", () => {
    // The failure this catches is a signed hash: `>>> 0` is what stops a
    // negative index handing back `undefined`, and `undefined` in an `<img src>`
    // is a broken image for an unlucky subset of users rather than a crash
    // anyone would notice.
    for (let i = 0; i < 500; i += 1) {
      expect(AVATARS).toContain(avatarFor(`user-${i}`));
    }
  });

  it("handles the nullable ids the schema actually produces", () => {
    // `decided_by_id` and `author_id` are both nullable: a user row can be
    // deleted out from under a decision that still stands. A hole in the layout
    // helps nobody, so these get a real file and the initials do the work.
    expect(AVATARS).toContain(avatarFor(null));
    expect(AVATARS).toContain(avatarFor(undefined, "content_creator"));
    expect(AVATARS).toContain(avatarFor(""));
  });
});

describe("initialsFor", () => {
  it("takes the first and last name", () => {
    expect(initialsFor("Sara Selim")).toBe("SS");
    expect(initialsFor("Amr Hassan Safieddine Nagy")).toBe("AN");
  });

  it("falls back to two letters of a single name", () => {
    expect(initialsFor("Cher")).toBe("CH");
  });

  it("survives the empty and the absent", () => {
    // Every account manager wears one face, so the initials are what
    // distinguish two people in the same job. They must always render.
    expect(initialsFor(null)).toBe("?");
    expect(initialsFor(undefined)).toBe("?");
    expect(initialsFor("   ")).toBe("?");
  });

  it("ignores extra whitespace between names", () => {
    expect(initialsFor("  Rana   Fouad  ")).toBe("RF");
  });
});
