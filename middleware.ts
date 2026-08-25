import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/config/session";

/**
 * The first gate every browser request passes.
 *
 * What it can and cannot do is decided by where it runs. Middleware runs on the
 * edge runtime, which has no Node crypto and no database driver, so it cannot
 * call `resolveSession` -- that needs a SHA-256 digest and a Prisma query. It
 * therefore checks only for the *presence* of a session cookie, and the layouts
 * do the real resolution against the database.
 *
 * That split is deliberate rather than a compromise. The cheap check here turns
 * away the overwhelmingly common case -- a visitor with no session at all --
 * without touching the database, and a forged cookie gets past it only to be
 * refused by `requireRole`, which reads the row. Nothing is trusted on the
 * strength of this check; it decides where to *send* a request, never what a
 * request may see.
 *
 * The failure this prevents is a role page rendering its shell, and its data
 * queries, for a visitor who was never signed in.
 */

/** Paths reachable with no session at all. Everything else needs one. */
const PUBLIC_PATHS = new Set(["/signin"]);

/**
 * Paths a signed-in user reaches even while `must_change_password` stands.
 *
 * Exactly the password screen and the endpoints it needs. Anything wider would
 * make the forced step advisory -- the point is that a contact holding only a
 * one-time code can reach this and nothing else.
 */
const PASSWORD_PATHS = new Set(["/password"]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // A signed-in visitor has no business on the sign-in screen. Sent to `/`,
  // which resolves their role and forwards -- middleware cannot know the role
  // itself, having no database.
  if (PUBLIC_PATHS.has(pathname)) {
    if (hasSession) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!hasSession) {
    const signin = new URL("/signin", request.url);
    // Where they were headed, so sign-in can return them there rather than
    // dumping every user on their role's home whatever they clicked.
    if (pathname !== "/") signin.searchParams.set("next", pathname);
    return NextResponse.redirect(signin);
  }

  // Has a cookie. Whether it resolves, and to whom, is the layouts' business --
  // including whether `must_change_password` sends them to `/password`, which
  // needs the user row this runtime cannot read.
  if (PASSWORD_PATHS.has(pathname)) return NextResponse.next();

  return NextResponse.next();
}

/**
 * What the middleware runs on.
 *
 * API routes are excluded: they answer 401 rather than redirecting, because
 * their caller is `fetch`, not a person, and a 302 to an HTML sign-in page is
 * not something a JSON caller can act on. `requireUser` is their gate.
 *
 * Static assets and the favicon are excluded so a signed-out visitor still gets
 * a styled sign-in page rather than a redirect loop over its own stylesheet.
 *
 * `brand` is excluded for a reason worth stating: the logo appears *on* the
 * sign-in page, so a visitor with no session must be able to fetch it. Guarding
 * it would redirect the image request to sign-in, and `next/image` would then be
 * handed an HTML page where it expected a webp -- which fails as a broken image
 * rather than as anything that names the cause.
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|brand|uploads).*)"],
};
