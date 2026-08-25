/**
 * The two pieces of furniture every screen in Phases 5–11 repeats: a titled
 * page header, and a card to put a section in. Here so a new screen is a list of
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
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
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
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {title ? <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2> : null}
      {children}
    </section>
  );
}

/** What a list renders when it has nothing yet — a sentence, not a blank panel. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}
