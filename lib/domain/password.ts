import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing.
 *
 * `scrypt` from node:crypto — a real key-derivation function, deliberately slow
 * and memory-hard, rather than a fast digest like SHA-256. A fast hash is the
 * wrong tool here: it lets an attacker with the table try billions of guesses a
 * second. No new dependency is needed for this.
 *
 * Stored format is self-describing, so the cost parameters can be raised later
 * without invalidating existing hashes:
 *
 *   scrypt$N$r$p$<salt-hex>$<derived-key-hex>
 *
 * A verify reads the parameters out of the stored string rather than assuming
 * today's constants, which is what makes an upgrade path possible.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** Cost parameters. N is the work factor; raising it makes every hash slower. */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** node's default maxmem (32 MB) is too small for N=16384, r=8. */
const MAXMEM = 64 * 1024 * 1024;

const PREFIX = "scrypt";

export const MIN_PASSWORD_LENGTH = 8;

export class WeakPasswordError extends Error {
  readonly code = "WEAK_PASSWORD";
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

/**
 * The bar a new password must clear.
 *
 * Deliberately minimal: a length floor and a rejection of the handful of
 * passwords everyone tries. Composition rules ("one uppercase, one symbol")
 * push people toward `Password1!` and are not what makes a password strong.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "qwertyui",
  "qwerty123",
  "letmein1",
  "changeme",
  "welcome1",
  "iloveyou",
  "admin123",
]);

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new WeakPasswordError("That password is too common — choose another.");
  }
}

/** Hash a password for storage. Throws on a password below the bar. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return hashWithoutPolicy(password);
}

/**
 * Hash without the strength check — for seeding known development credentials,
 * which are deliberately simple and are not real secrets.
 */
export async function hashWithoutPolicy(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });

  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed or missing hash: a user
 * with no password yet (an invited client contact) must fail to sign in, not
 * crash the login route.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) return false;

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, nRaw, rRaw, pRaw, saltHex, keyHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  // The stored key must be full length. Deriving to whatever length happens to
  // be stored would mean a truncated hash still verifies -- shortened far
  // enough, a few bytes are trivially brute-forced.
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }

  // Length-equal by construction, but guard anyway: timingSafeEqual throws on a
  // length mismatch, which would itself leak information.
  if (derived.length !== expected.length) return false;

  return timingSafeEqual(derived, expected);
}

/** Whether a stored hash was produced with the current cost parameters. */
export function needsRehash(storedHash: string | null | undefined): boolean {
  if (!storedHash) return true;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return true;

  return (
    Number(parts[1]) !== PARAMS.N ||
    Number(parts[2]) !== PARAMS.r ||
    Number(parts[3]) !== PARAMS.p
  );
}
