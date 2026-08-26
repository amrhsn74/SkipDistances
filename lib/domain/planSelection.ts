/**
 * Which proposed items the creator actually asked to have drafted.
 *
 * The engine proposes a plan; the creator chooses from it; only the chosen items
 * are drafted, checked and persisted. This module is the rule that connects the
 * two, and it is pure so that "what did they pick" can be tested without a model
 * or a database.
 *
 * The selection is a *narrowing* and can only ever be one. A creator may drop an
 * item the engine proposed; they cannot add one, reword one, or change the
 * clauses it was written under. That asymmetry is the whole safety argument:
 * everything that survives selection is something the engine itself produced and
 * that compliance will still judge, so no guarantee is weakened by letting a
 * human take things off the list.
 *
 * What is deliberately NOT here: any notion of a default. An empty selection
 * means "nothing was chosen", not "choose everything" -- see `selectItems`.
 */

/** A proposal, identified by position. */
export type SelectableItem = {
  title: string;
  content_form: string;
  platform: string | null;
};

export class PlanSelectionError extends Error {
  readonly code = "PLAN_SELECTION";
  constructor(message: string) {
    super(message);
    this.name = "PlanSelectionError";
  }
}

/**
 * Items are chosen by index into the proposed plan.
 *
 * By index rather than by title, because titles are model output: two proposals
 * in one plan can carry the same title, and a selection that silently drafted
 * both because their names matched would produce work nobody asked for. An index
 * is unambiguous and is what the UI already has.
 */
export type Selection = number[];

/**
 * Validate a selection against the plan it refers to.
 *
 * Every index must land on a real proposal. An out-of-range index is refused
 * rather than skipped: it means the screen and the server disagree about what
 * was proposed, and quietly drafting the subset they happen to agree on would
 * hide that from everyone.
 */
export function validateSelection(selection: Selection, proposedCount: number): void {
  if (proposedCount === 0) {
    throw new PlanSelectionError("There is nothing to choose from.");
  }

  if (selection.length === 0) {
    throw new PlanSelectionError("Choose at least one item to draft.");
  }

  const seen = new Set<number>();
  for (const index of selection) {
    if (!Number.isInteger(index) || index < 0 || index >= proposedCount) {
      throw new PlanSelectionError(
        `No proposed item at position ${index}. The plan has ${proposedCount}.`,
      );
    }
    // Refused rather than de-duplicated. A repeated index means the caller has
    // lost track of what it is asking for, and drafting it once silently would
    // leave that disagreement in place.
    if (seen.has(index)) {
      throw new PlanSelectionError(`Item ${index} was chosen twice.`);
    }
    seen.add(index);
  }
}

/**
 * Narrow a proposed plan to what was chosen.
 *
 * Returns the items in the plan's own order, not the order they were ticked in:
 * the plan's order is the engine's sequencing of a campaign, and letting a
 * click order rewrite it would change the content for no reason anyone intended.
 *
 * There is no "select all" default on purpose. A caller that wants everything
 * says so by passing every index -- so a selection lost somewhere between the
 * screen and the server can never be mistaken for a request to draft the lot,
 * which is precisely the automatic drafting this design removes.
 */
export function selectItems<T extends SelectableItem>(items: T[], selection: Selection): T[] {
  validateSelection(selection, items.length);

  const chosen = new Set(selection);
  return items.filter((_item, index) => chosen.has(index));
}
