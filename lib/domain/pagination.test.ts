import { describe, it, expect } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  parsePage,
  toPage,
  toSkipTake,
} from "./pagination";

describe("parsePage", () => {
  it("defaults an absent query string", () => {
    expect(parsePage(null, null)).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("reads a real page and size", () => {
    expect(parsePage("3", "50")).toEqual({ page: 3, pageSize: 50 });
  });

  /**
   * Clamped rather than rejected. Someone editing a URL is not an attacker, and
   * page 1 is a more useful answer than a 400.
   */
  it.each([
    ["0", 1],
    ["-4", 1],
    ["banana", 1],
    ["", 1],
  ])("clamps page %s to %i", (raw, expected) => {
    expect(parsePage(raw, null).page).toBe(expected);
  });

  /** The one that actually costs something if it is honoured. */
  it("caps an absurd page size", () => {
    expect(parsePage("1", "100000").pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("raises a tiny page size to the minimum", () => {
    expect(parsePage("1", "1").pageSize).toBe(MIN_PAGE_SIZE);
  });
});

describe("toSkipTake", () => {
  it("skips nothing on page 1", () => {
    expect(toSkipTake({ page: 1, pageSize: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it("skips a whole page per page", () => {
    expect(toSkipTake({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
  });
});

describe("toPage", () => {
  it("reports the surrounding pages", () => {
    const page = toPage([1, 2, 3], 25, { page: 2, pageSize: 10 });

    expect(page.totalPages).toBe(3);
    expect(page.hasPrevious).toBe(true);
    expect(page.hasNext).toBe(true);
  });

  it("knows the first and last page", () => {
    expect(toPage([], 25, { page: 1, pageSize: 10 }).hasPrevious).toBe(false);
    expect(toPage([], 25, { page: 3, pageSize: 10 }).hasNext).toBe(false);
  });

  /**
   * "Page 1 of 0" reads as a bug to anyone looking at it, so an empty result
   * still has one page.
   */
  it("reports one page for an empty result", () => {
    const page = toPage([], 0, { page: 1, pageSize: 20 });

    expect(page.totalPages).toBe(1);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
  });

  it("carries the total from before the page was taken", () => {
    // 3 rows on screen, 147 matching overall -- the screen needs both.
    expect(toPage([1, 2, 3], 147, { page: 5, pageSize: 3 }).total).toBe(147);
  });
});
