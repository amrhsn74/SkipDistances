import Link from "next/link";

/**
 * The furniture every screen repeats: a titled page header, a card to put a
 * section in, an empty state, a status badge, the headline-number cards every
 * overview opens with, and a table in a card. Here so a new screen is a list of
 * sections rather than a fresh set of Tailwind guesses.
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

/**
 * A heading above a section that draws its own container.
 *
 * `Card` gives a heading *and* a border; a `DataTable` already has the border,
 * so pairing them nests two cards. This is the heading half on its own, with an
 * optional action on the right.
 */
export function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 font-heading text-base font-semibold text-heading">
        {title}
        {count !== undefined ? (
          <span className="skip-pill bg-canvas text-body">{count}</span>
        ) : null}
      </h2>
      {action}
    </div>
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

/**
 * A headline number, as a tinted card.
 *
 * Every role's overview opens with a row of these, and each one is a link to
 * the screen where that number becomes work. The tint is the point: a count of
 * flagged items on a white card beside three other white cards is a number
 * nobody's eye lands on, and PRD §6 makes these the only place work surfaces.
 *
 * `tone` names the meaning, never the colour -- same indirection as `Badge`, and
 * for the same reason. Note that none of the tones is amber: amber is the brand
 * chrome, so a count wearing it would read as decoration rather than as
 * something waiting.
 */
export type StatTone = "info" | "flag" | "ok" | "danger" | "neutral";

const STAT_TONES: Record<StatTone, { bg: string; value: string }> = {
  info: { bg: "bg-info-bg", value: "text-info" },
  flag: { bg: "bg-flag-bg", value: "text-flag" },
  ok: { bg: "bg-ok-bg", value: "text-ok" },
  danger: { bg: "bg-danger-bg", value: "text-danger" },
  neutral: { bg: "bg-surface border border-edge", value: "text-heading" },
};

export function StatCard({
  label,
  value,
  href,
  tone = "neutral",
  hint,
  /**
   * Drop to the neutral treatment when the count is zero. A permanently red
   * zero trains the eye to skip the one number that matters when it is not.
   */
  quietWhenZero = true,
}: {
  label: string;
  value: number | string;
  href?: string;
  tone?: StatTone;
  hint?: string;
  quietWhenZero?: boolean;
}) {
  const isZero = value === 0;
  const effective: StatTone = quietWhenZero && isZero ? "neutral" : tone;
  const { bg, value: valueColor } = STAT_TONES[effective];

  const body = (
    <>
      <p className={`font-heading text-3xl font-semibold ${valueColor}`}>{value}</p>
      <p className="mt-1 text-xs leading-snug text-body">{label}</p>
      {hint ? <p className="mt-0.5 text-xs text-body/60">{hint}</p> : null}
    </>
  );

  const shell = `block rounded-2xl p-5 text-left shadow-sm ${bg}`;

  return href ? (
    <Link href={href} className={`${shell} transition-shadow hover:shadow-md`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/**
 * The row those cards sit in, so four of them wrap the same way everywhere.
 *
 * `flush` drops the bottom margin, for the case where the row is the last thing
 * inside a card that already has its own padding.
 */
export function StatRow({
  children,
  flush = false,
}: {
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-4 ${flush ? "" : "mb-7"}`}>
      {children}
    </div>
  );
}

/**
 * A table in a card, with the header strip the mockups use.
 *
 * `headers` rather than a `<thead>` child so no caller has to remember the
 * strip's classes. An empty-string header renders an unlabelled column, which
 * is what the trailing actions column wants.
 */
export function DataTable({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: React.ReactNode;
  /** Rendered instead of the table body when there is nothing to show. */
  empty?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-edge bg-canvas">
              {headers.map((header, index) => (
                <th key={header || `col-${index}`} scope="col" className="skip-th">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          {empty ? null : <tbody>{children}</tbody>}
        </table>
      </div>
      {empty ? <div className="px-4 py-10 text-center text-sm text-body/70">{empty}</div> : null}
    </div>
  );
}
