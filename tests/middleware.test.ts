import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/api/request";
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
