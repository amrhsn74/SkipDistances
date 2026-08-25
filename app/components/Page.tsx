/**
 * The furniture every screen repeats: a titled page header, a card to put a
 * section in, an empty state, and a status badge. Here so a new screen is a
 * list of sections rather than a fresh set of Tailwind guesses.
 */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-body">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-edge bg-surface p-6 shadow-sm">
      {title ? (
        <h2 className="mb-4 font-heading text-base font-semibold text-heading">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

/** What a list renders when it has nothing yet — a sentence, not a blank panel. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-edge px-4 py-8 text-center text-sm text-body">
      {children}
    </p>
  );
}

/**
 * A status badge.
 *
 * `tone` names what the badge *means*, never a colour. That indirection is what
 * let "flagged" move off amber when amber became the brand chrome, without
 * touching a single caller -- and it is why a future palette change is one file.
 */
export type BadgeTone = "neutral" | "ok" | "flag" | "danger" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-canvas text-body border-edge",
  ok: "bg-ok-bg text-ok border-ok/20",
  flag: "bg-flag-bg text-flag border-flag/20",
  danger: "bg-danger-bg text-danger border-danger/20",
  info: "bg-info-bg text-info border-info/20",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
