import Image from "next/image";
import { Suspense } from "react";

import { SignInForm } from "./SignInForm";

/**
 * The only page in the product reachable without a session.
 *
 * The form is a client component because it holds credential state; this page
 * stays a server component so nothing about who is signed in is decided in the
 * browser. `Suspense` is required around it: `useSearchParams` opts the subtree
 * into client-side rendering, and Next refuses to build the page without a
 * boundary.
 */
export const metadata = { title: "Sign in · Skip Studio" };

export default function SignInPage() {
  return (
    // Centred on the canvas rather than under a full-width amber band. The
    // band put the brand on screen but pushed the form off centre; the lockup
    // above the card carries the identity in the space the form is already in.
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-brand shadow-sm">
            <Image
              src="/brand/logo.webp"
              alt=""
              aria-hidden
              width={172}
              height={80}
              priority
              className="h-6 w-auto"
            />
          </span>
          <span className="font-heading text-2xl font-bold tracking-tight text-heading">
            Skip Studio
          </span>
        </div>

        <div className="rounded-2xl border border-edge bg-surface p-8 shadow-sm">
          <h1 className="font-heading text-xl font-semibold text-heading">Sign in</h1>
          <p className="mb-6 mt-1 text-sm text-body">
            Reach your clients and their work.
          </p>

          <Suspense fallback={null}>
            <SignInForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-body/60">
          Skip Studio · Content Operations Platform
        </p>
      </div>
    </div>
  );
}
