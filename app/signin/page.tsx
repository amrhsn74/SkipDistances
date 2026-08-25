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
    <div className="flex min-h-screen flex-col">
      {/* The amber band, so the brand is the first thing on screen. */}
      <div className="bg-amber-brand py-10">
        <div className="mx-auto flex max-w-sm flex-col items-center px-6">
          <Image
            src="/brand/logo.webp"
            alt="Skip Studio"
            width={172}
            height={80}
            priority
            className="h-14 w-auto"
          />
        </div>
      </div>

      <div className="flex flex-1 items-start justify-center px-6 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="font-heading text-2xl font-semibold text-heading">
              Content operations
            </h1>
            <p className="mt-1 text-sm text-body">
              Sign in to reach your clients and their work.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-surface p-6 shadow-sm">
            <Suspense fallback={null}>
              <SignInForm />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
