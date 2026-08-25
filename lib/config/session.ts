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
