import Image from "next/image";
import { redirect } from "next/navigation";

import { currentUser } from "@/api/request";
import { prisma } from "@/db";

import { SetPasswordForm } from "./SetPasswordForm";

/**
 * The forced password screen.
 *
 * Outside the role layouts on purpose. A user carrying `must_change_password`
 * can reach nothing else -- putting this under a role's layout would mean
 * resolving their role and rendering a nav full of links they are not yet
 * allowed to follow.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Set your password · Skip Studio" };

export default async function PasswordPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  // Whether they already hold a password decides whether the form asks for the
  // current one. Read from the row rather than inferred from
  // `must_change_password`: an established user changing a password voluntarily
  // has that flag clear and still must prove the old one.
  const row = await prisma.user.findUniqueOrThrow({
    where: { user_id: user.user_id },
    select: { password_hash: true },
  });

  const first = row.password_hash === null;

  return (
    <div className="flex min-h-screen flex-col">
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
              {first ? "Set your password" : "Change your password"}
            </h1>
            <p className="mt-1 text-sm text-body">
              {first
                ? "The one-time code got you in. Choose a password to keep."
                : "Signing in elsewhere will need the new one."}
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-surface p-6 shadow-sm">
            <SetPasswordForm needsCurrent={!first} />
          </div>
        </div>
      </div>
    </div>
  );
}
