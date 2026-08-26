import { avatarFor, initialsFor, type AvatarRole } from "@/domain/avatars";

/**
 * A person, as a face.
 *
 * Deliberately **not** a client component. It renders an `<img>` and nothing
 * else -- no state, no handlers -- so leaving it a server component lets it be
 * used from both sides: the sidebar is a client component, the review card is
 * not, and both need this. A `"use client"` here would drag every server caller
 * across the boundary for no gain.
 *
 * Plain `<img>` rather than `next/image`, for once with a reason beyond
 * convenience. These are a handful of small fixed assets rendered at 24-40px,
 * often several to a row; `next/image` would run its optimiser over each and add
 * a wrapper per face on screens that already render twenty. The bytes saved on a
 * 40px avatar do not pay for that.
 *
 * The initials sit underneath as the fallback, revealed if the file is missing.
 * That is not decoration: the artwork is one face per role, so every account
 * manager on screen wears the same one -- the initials are what distinguish two
 * people in the same job.
 *
 * `role` is optional because it is often genuinely unknown. A comment thread
 * knows who wrote each message but not what they do, and resolving that would be
 * a query per row; without it the face is still stable per person, just not
 * role-accurate. Pass it wherever it is already to hand.
 */

const SIZES = {
  sm: { box: "h-6 w-6", text: "text-[10px]" },
  md: { box: "h-8 w-8", text: "text-xs" },
  lg: { box: "h-10 w-10", text: "text-sm" },
} as const;

export type AvatarSize = keyof typeof SIZES;

export function Avatar({
  userId,
  name,
  role,
  size = "md",
  className = "",
}: {
  /** Null is fine -- `decided_by_id` and `author_id` are both nullable. */
  userId: string | null | undefined;
  name: string | null | undefined;
  /** Pass where it is already resolved; the picture is then role-accurate. */
  role?: AvatarRole | null;
  size?: AvatarSize;
  className?: string;
}) {
  const { box, text } = SIZES[size];
  const label = name ?? "Unknown";

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-canvas ring-1 ring-edge ${box} ${className}`}
      // The accessible name for the whole stack. The `<img>` below is marked
      // decorative so a screen reader is not handed the same person twice.
      role="img"
      aria-label={label}
      title={label}
    >
      <span className={`font-heading font-semibold text-body/70 ${text}`} aria-hidden="true">
        {initialsFor(name)}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarFor(userId, role)}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        // Absolute, over the initials. A missing file leaves the initials
        // showing rather than a broken-image glyph -- the layout holds either
        // way, which is what makes the fallback worth having.
        className="absolute inset-0 h-full w-full object-cover"
      />
    </span>
  );
}

/**
 * A face with a name beside it.
 *
 * The common pairing on decision lines, comment threads and audit rows, kept
 * here so those three do not each invent their own spacing.
 */
export function AvatarName({
  userId,
  name,
  role,
  size = "sm",
  fallback = "Someone",
  className = "",
}: {
  userId: string | null | undefined;
  name: string | null | undefined;
  role?: AvatarRole | null;
  size?: AvatarSize;
  /** Shown when the row has no name -- a deleted user still has a decision. */
  fallback?: string;
  className?: string;
}) {
  const label = name ?? fallback;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Avatar userId={userId} name={label} role={role} size={size} />
      <span>{label}</span>
    </span>
  );
}
