import { describe, it, expect } from "vitest";

import { PlanSelectionError, selectItems, validateSelection } from "./planSelection";

/**
 * The rule behind "draft by user". An item the creator did not tick must not
 * reach compliance, the database, or an image call -- so the narrowing has to be
 * exact, and it must never quietly widen itself into "draft everything".
 */

const PROPOSED = [
  { title: "Cold brew launch post", content_form: "post", platform: "instagram" },
  { title: "Origin story reel", content_form: "reel", platform: "tiktok" },
  { title: "Barista feature image", content_form: "image", platform: "instagram" },
];

describe("choosing what to draft", () => {
  it("keeps only the chosen items", () => {
    const chosen = selectItems(PROPOSED, [0, 2]);

    expect(chosen).toHaveLength(2);
    expect(chosen.map((item) => item.title)).toEqual([
      "Cold brew launch post",
      "Barista feature image",
    ]);
  });

  it("returns items in the plan's order, not the order they were ticked", () => {
    // The plan's order is the engine's sequencing of a campaign. A click order
    // must not rewrite it.
    const chosen = selectItems(PROPOSED, [2, 0]);

    expect(chosen.map((item) => item.title)).toEqual([
      "Cold brew launch post",
      "Barista feature image",
    ]);
  });

  it("refuses an empty selection rather than drafting everything", () => {
    // The whole point: nothing ticked means nothing drafted. A default of "all"
    // is how automatic drafting would creep back in.
    expect(() => selectItems(PROPOSED, [])).toThrow(PlanSelectionError);
  });

  it("refuses an index the plan does not have", () => {
    // The screen and the server disagree about what was proposed. Drafting the
    // subset they happen to agree on would hide that from both.
    expect(() => selectItems(PROPOSED, [0, 7])).toThrow(/No proposed item at position 7/);
  });

  it("refuses a negative or fractional index", () => {
    expect(() => selectItems(PROPOSED, [-1])).toThrow(PlanSelectionError);
    expect(() => selectItems(PROPOSED, [1.5])).toThrow(PlanSelectionError);
  });

  it("refuses the same item chosen twice", () => {
    expect(() => selectItems(PROPOSED, [1, 1])).toThrow(/chosen twice/);
  });

  it("refuses to choose from an empty plan", () => {
    expect(() => validateSelection([0], 0)).toThrow(/nothing to choose from/);
  });

  it("can choose everything, but only by saying so", () => {
    expect(selectItems(PROPOSED, [0, 1, 2])).toHaveLength(3);
  });
});
