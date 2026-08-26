import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/api/request";
import { STALE_SESSION_MARKER } from "@/config/session";
import { config, middleware } from "@/middleware";

/**
 * Where the middleware sends a request.
 *
 * What it deliberately does *not* do is resolve the session -- it runs on the
 * edge runtime, with no Node crypto and no database driver, so it can see that a
 * cookie exists and nothing more. These tests assert the routing decisions only.
 * That a *forged* cookie gets no further than the layout is
 * `requireRole`'s job, and is covered by the route tests that exercise
 * `resolveSession` against a fake token.
 */

function request(path: string, cookie?: string) {
  const req = new NextRequest(new URL(`http://localhost${path}`));
  if (cookie !== undefined) req.cookies.set(SESSION_COOKIE, cookie);
  return req;
}

/** The Location header, or null when the middleware let the request through. */
function redirectTo(response: Response): string | null {
  const location = response.headers.get("location");
  return location === null ? null : new URL(location).pathname + new URL(location).search;
}

describe("a visitor with no session", () => {
  it("is sent to sign-in from a role page", () => {
    const response = middleware(request("/AccountManager"));
    expect(redirectTo(response)).toBe("/signin?next=%2FAccountManager");
  });

  /**
   * The reason `next` is carried at all: without it every user lands on their
   * role home whatever link they followed, which turns a shared deep link into
   * a dead one.
   */
  it("keeps where it was headed, so sign-in can return it there", () => {
    const response = middleware(request("/Client/approvals"));
    expect(redirectTo(response)).toBe("/signin?next=%2FClient%2Fapprovals");
  });

  it("carries no next parameter from the root, which resolves on its own", () => {
    expect(redirectTo(middleware(request("/")))).toBe("/signin");
  });

  it("reaches the sign-in page itself", () => {
    expect(redirectTo(middleware(request("/signin")))).toBeNull();
  });

  it("is sent to sign-in from the password screen", () => {
    // The password screen needs a session to know whose password it is setting.
    expect(redirectTo(middleware(request("/password")))).toBe("/signin?next=%2Fpassword");
  });
});

/**
 * The brand assets must stay reachable without a session.
 *
 * Not a hypothetical: guarding `/brand` redirected the logo request to sign-in,
 * and `next/image` was handed an HTML page where it expected a webp. It failed
 * as a broken image on the sign-in screen -- the one page where the logo has to
 * work for a visitor who by definition has no session.
 */
describe("public assets", () => {
  /**
   * Asserted against the matcher rather than the handler, because the matcher is
   * what actually exempts these paths -- the handler would happily redirect
   * `/brand/logo.webp`, and never sees it precisely because of this list.
   */
  const matcher = config.matcher[0];

  it.each(["brand", "uploads", "_next/static", "favicon.ico", "api"])(
    "keeps %s out of the matcher",
    (segment) => {
      expect(matcher).toContain(segment);
    },
  );
});

describe("a visitor holding a session cookie", () => {
  it("passes through to a role page", () => {
    expect(redirectTo(middleware(request("/AccountManager", "a-token")))).toBeNull();
  });

  it("reaches the password screen", () => {
    // Reachable while `must_change_password` stands -- and it is the only thing
    // that is. Whether the flag is set is read from the row by the layouts.
    expect(redirectTo(middleware(request("/password", "a-token")))).toBeNull();
  });

  it("is bounced off the sign-in page to the root, which resolves their role", () => {
    expect(redirectTo(middleware(request("/signin", "a-token")))).toBe("/");
  });

  /**
   * An empty cookie value is not a session. Treating the header's presence as
   * proof would let a cleared cookie that the browser still sends walk past.
   */
  it("is treated as signed out when the cookie is empty", () => {
    expect(redirectTo(middleware(request("/AccountManager", "")))).toBe(
      "/signin?next=%2FAccountManager",
    );
  });
});

/**
 * The redirect loop, and the handshake that ends it.
 *
 * This runtime can see that a session cookie is *present* and never whether it
 * still resolves -- it has no database. So a browser holding an expired,
 * revoked, or deleted session used to be sent to `/`, found to be nobody there,
 * redirected back to `/signin`, and bounced to `/` again: a loop no reload could
 * escape, ending in the browser's own "redirected you too many times".
 *
 * The way out is that `/` and `requireRole` know something this does not, and
 * say so on the redirect. These are the tests that keep the handshake honest --
 * the bug is invisible until someone's cookie goes stale, which is exactly when
 * nobody is looking.
 */
describe("a stale session cookie", () => {
  it("serves the sign-in page rather than bouncing it back to the root", () => {
    const response = middleware(request(`/signin?${STALE_SESSION_MARKER}`, "dead-token"));

    // The half of the loop this runtime owns. Redirecting here is what made it
    // a cycle rather than a single wasted round trip.
    expect(redirectTo(response)).toBeNull();
  });

  it("expires the cookie, so the next request is honestly signed out", () => {
    const response = middleware(request(`/signin?${STALE_SESSION_MARKER}`, "dead-token"));

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE);
    // Max-Age=0 is the expiry. Without it the browser keeps presenting the dead
    // token and the loop resumes on the next navigation.
    expect(setCookie).toContain("Max-Age=0");
  });

  it("still redirects a cookie-holder who simply typed /signin", () => {
    const response = middleware(request("/signin", "live-token"));

    // No marker means no round trip has failed yet, so the cookie is presumed
    // good. Clearing it here would silently sign out anyone who visited the URL.
    expect(redirectTo(response)).toBe("/");
  });

  it("leaves a signed-out visitor's cookie alone", () => {
    const response = middleware(request("/signin"));

    expect(redirectTo(response)).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
