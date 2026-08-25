import { describe, it, expect } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  assertPasswordAcceptable,
  hashPassword,
  hashWithoutPolicy,
  needsRehash,
  verifyPassword,
} from "./password";

const GOOD = "correct-horse-battery";

describe("hashPassword", () => {
  it("never stores the password itself", async () => {
    const hash = await hashPassword(GOOD);

    expect(hash).not.toBe(GOOD);
    expect(hash).not.toContain(GOOD);
  });

  it("produces a different hash each time, so the salt is per-hash", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);

    // Identical passwords hashing identically would let an attacker see which
    // users share one, and make a precomputed table viable.
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it("records its parameters, so cost can be raised later", async () => {
    const hash = await hashPassword(GOOD);
    const [scheme, N, r, p, salt, key] = hash.split("$");

    expect(scheme).toBe("scrypt");
    expect(Number(N)).toBeGreaterThanOrEqual(16384);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    expect(salt.length).toBeGreaterThan(0);
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password", async () => {
    expect(await verifyPassword(GOOD, await hashPassword(GOOD))).toBe(true);
  });

  it("rejects a near miss", async () => {
    const hash = await hashPassword(GOOD);

    for (const wrong of [
      "correct-horse-batter",   // one char short
      "correct-horse-batteryy", // one char long
      "Correct-horse-battery",  // case
      "correct horse battery",  // separators
      "",
    ]) {
      expect(await verifyPassword(wrong, hash), wrong).toBe(false);
    }
  });

  it("returns false for a user with no password rather than throwing", async () => {
    // An invited client contact has password_hash = null. The login route must
    // reject them, not crash.
    expect(await verifyPassword(GOOD, null)).toBe(false);
    expect(await verifyPassword(GOOD, undefined)).toBe(false);
    expect(await verifyPassword(GOOD, "")).toBe(false);
  });

  it("returns false for a malformed hash rather than throwing", async () => {
    for (const bad of [
      "not-a-hash",
      "scrypt$only$three$parts",
      "bcrypt$16384$8$1$aabb$ccdd",
      "scrypt$notanumber$8$1$aabb$ccdd",
      "scrypt$16384$8$1$$",
    ]) {
      expect(await verifyPassword(GOOD, bad), bad).toBe(false);
    }
  });

  it("does not accept a hash whose stored key was truncated", async () => {
    const hash = await hashPassword(GOOD);
    const parts = hash.split("$");
    parts[5] = parts[5].slice(0, 32);

    expect(await verifyPassword(GOOD, parts.join("$"))).toBe(false);
  });
});

describe("password policy", () => {
  it("rejects anything shorter than the minimum", async () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);

    expect(() => assertPasswordAcceptable(short)).toThrow(WeakPasswordError);
    await expect(hashPassword(short)).rejects.toThrow(WeakPasswordError);
  });

  it("rejects the passwords everyone tries first", async () => {
    for (const p of ["password", "Password123", "12345678", "changeme"]) {
      expect(() => assertPasswordAcceptable(p), p).toThrow(WeakPasswordError);
    }
  });

  it("accepts a reasonable password", () => {
    expect(() => assertPasswordAcceptable(GOOD)).not.toThrow();
  });

  it("hashWithoutPolicy skips the check, for seeding known dev credentials", async () => {
    // The seeded development password is deliberately simple and is not a
    // secret; it must not have to satisfy the policy real users do.
    const hash = await hashWithoutPolicy("skipstudio-dev");
    expect(await verifyPassword("skipstudio-dev", hash)).toBe(true);
  });
});

describe("needsRehash", () => {
  it("is false for a hash at the current parameters", async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it("is true for a weaker hash, so it can be upgraded on next sign-in", async () => {
    const hash = await hashPassword(GOOD);
    const parts = hash.split("$");
    parts[1] = "1024"; // an older, cheaper N

    expect(needsRehash(parts.join("$"))).toBe(true);
  });

  it("is true for a missing or unrecognised hash", () => {
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash("bcrypt$whatever")).toBe(true);
  });
});
