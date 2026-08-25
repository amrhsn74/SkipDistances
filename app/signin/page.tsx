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
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Skip Studio
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Content operations for the agency and its clients.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <Suspense fallback={null}>
            <SignInForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
