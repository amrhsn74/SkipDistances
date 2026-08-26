/**
 * Which picture stands for a person.
 *
 * Keyed on **role**, not on identity. The artwork is one face per role -- an
 * account manager, an admin, a content lead, two creators -- so the picture
 * beside a name says what that person does, which is the thing a reader of these
 * screens actually needs. A pool of anonymous faces hashed to user ids would put
 * the admin's portrait next to a creator, and a reader who learned to recognise
 * one would then be misled by it.
 *
 * No imports at all, deliberately: the edge middleware, a server component and a
 * client component all need this answer, and any import here would be the thing
 * that stops one of them using it. No `User.avatar_url` column either, so there
 * is no migration, no seed change, and no fallback branch for the 150+ seeded
 * contacts nobody hand-assigned a picture to.
 *
 * What this costs: nobody chooses their own. That is the right trade for a demo
 * roster of this size, and adding a nullable column later is a small change --
 * `avatarFor` would read it and fall back to here, which is the shape it already
 * has.
 *
 * **Where a role has more than one face**, the choice is a hash of the user id.
 * Stable is the whole requirement: the same person must get the same picture on
 * every screen and every render, or the avatar stops identifying anyone and
 * becomes decoration that actively misleads.
 */

/** The five role identities the rest of the app already resolves. */
export type AvatarRole =
  | "account_manager"
  | "content_lead"
  | "content_creator"
  | "client_contact"
  | "agency_admin";

/**
 * The artwork, per role.
 *
 * A list per role rather than a single path, because two creator faces exist and
 * a sixth is expected. A role with several faces picks by hash; a role with one
 * always returns it. Adding the sixth file is appending one string here -- no
 * other code changes.
 *
 * `client_contact` has no artwork of its own yet, so it borrows the pool of
 * every distinct face available. That is honest rather than ideal: a contact is
 * shown *a* consistent face, and when a contact portrait exists it replaces this
 * list and nothing else moves.
 */
const BY_ROLE: Record<AvatarRole, readonly string[]> = {
  account_manager: ["/avatars/account-manager.png"],
  agency_admin: ["/avatars/agency-admin.png"],
  content_lead: ["/avatars/content-lead.png"],
  content_creator: ["/avatars/content-creator-1.png", "/avatars/content-creator-2.png"],
  client_contact: [
    "/avatars/content-creator-2.png",
    "/avatars/content-lead.png",
    "/avatars/agency-admin.png",
  ],
};

/** Every distinct file referenced above -- what a caller with no role falls back to. */
export const AVATARS: readonly string[] = Array.from(
  new Set(Object.values(BY_ROLE).flat()),
);

/**
 * A stable index for an id.
 *
 * FNV-1a, which is neither cryptographic nor trying to be: this picks a picture,
 * so all it must do is spread ids evenly and return the same number every time.
 * `>>> 0` keeps it unsigned -- JavaScript's `<<` produces a signed 32-bit
 * integer, and a negative index would silently hand back `undefined`, which in
 * an `<img src>` is a broken image for an unlucky subset of users rather than an
 * obvious crash.
 */
function hashToIndex(id: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash % buckets;
}

/**
 * The avatar for a person.
 *
 * Both arguments are nullable so callers can pass a `decided_by_id` or an
 * `author_id` straight through -- both are nullable in the schema, because a
 * user row can be deleted out from under a decision that still stands. And the
 * role is often simply unknown: a comment thread knows who wrote each message
 * but not what they do, and resolving that would mean a query per row.
 *
 * With no role, the choice falls back to the whole pool. The picture is then
 * still stable for that person, just not role-accurate -- which is the correct
 * trade against an N+1 on every thread.
 */
export function avatarFor(
  userId: string | null | undefined,
  role?: AvatarRole | null,
): string {
  const pool = role ? BY_ROLE[role] : AVATARS;
  if (pool.length === 1) return pool[0];
  if (!userId) return pool[0];
  return pool[hashToIndex(userId, pool.length)];
}

/**
 * Up to two initials from a display name.
 *
 * The real identifier on screen. Faces repeat across a roster this size, so the
 * picture is recognition at a glance and the initials are what distinguish two
 * people who happen to share one.
 */
export function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
