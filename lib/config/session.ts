/**
 * The session cookie's name, and nothing else.
 *
 * Its own module, with no imports at all, because `middleware.ts` needs it and
 * middleware runs on the edge runtime. Importing it from `lib/api/request.ts`
 * -- where it used to live -- pulled that module's `lib/db` import along with
 * it, and Prisma's `node:os` and `node:path` requires do not exist on the edge:
 * the build failed with `UnhandledSchemeError` rather than at runtime, which at
 * least is the good version of that mistake.
 *
 * `request.ts` re-exports this, so callers that already import `SESSION_COOKIE`
 * from there keep working and there is still exactly one definition.
 */
export const SESSION_COOKIE = "skipstudio_session";

/**
 * The query flag `/` adds when it sends a cookie-holding visitor to sign-in.
 *
 * It carries the one fact the edge middleware cannot work out for itself: this
 * cookie has already been offered to the database and resolved to nobody, so it
 * is dead and should be cleared rather than trusted for another round trip.
 *
 * Here, with `SESSION_COOKIE`, because both sides of that handshake need the
 * same string and they run in different runtimes -- a page cannot import from
 * `middleware.ts`, and middleware cannot import anything that reaches for
 * Prisma.
 */
export const STALE_SESSION_MARKER = "stale";
