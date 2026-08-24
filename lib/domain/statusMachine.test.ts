import { describe, it, expect } from "vitest";

import {
  CONTENT_STATUSES,
  TERMINAL_FOR_DECLINE,
  applyTransition,
  canDecline,
  canEdit,
  isLegalTransition,
  legalNextStatuses,
  resetFor,
  type ContentStatus,
  type TransitionCause,
} from "./statusMachine";

/**
 * Written before the implementation, per the plan: this is the highest-value
 * file in the project, and the transition table is the spec.
 *
 * The one rule that shapes everything here: any invalidation -- a content edit,
 * a scheduled_date change, or a late decline, from either party -- produces the
 * identical reset to `drafted`. One rule, no per-cause branching.
 */

const ALL: ContentStatus[] = [...CONTENT_STATUSES];

describe("P2.7a — legal forward transitions", () => {
  it("walks the happy path from drafted to published", () => {
    const path: Array<[ContentStatus, ContentStatus]> = [
      ["drafted", "pending_internal_review"],
      ["pending_internal_review", "internal_approved"],
      ["internal_approved", "pending_client_review"],
      ["pending_client_review", "client_approved"],
      ["client_approved", "scheduled"],
      ["scheduled", "publishing"],
      ["publishing", "published"],
    ];

    for (const [from, to] of path) {
      expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("allows refinement before review, and back", () => {
    expect(isLegalTransition("drafted", "in_refinement")).toBe(true);
    expect(isLegalTransition("in_refinement", "drafted")).toBe(true);
    expect(isLegalTransition("in_refinement", "pending_internal_review")).toBe(true);
  });

  it("allows a publish attempt to fail", () => {
    expect(isLegalTransition("publishing", "publish_failed")).toBe(true);
  });

  it("allows a failed publish to be retried or pulled back", () => {
    expect(isLegalTransition("publish_failed", "scheduled")).toBe(true);
    expect(isLegalTransition("publish_failed", "drafted")).toBe(true);
  });

  it("allows the engine to flag an item at draft time", () => {
    expect(isLegalTransition("drafted", "flagged")).toBe(true);
    expect(isLegalTransition("flagged", "drafted")).toBe(true);
  });

  it("never skips the client stage", () => {
    // The whole point of two-stage review: internal approval alone is not
    // enough to schedule.
    expect(isLegalTransition("internal_approved", "scheduled")).toBe(false);
    expect(isLegalTransition("internal_approved", "client_approved")).toBe(false);
    expect(isLegalTransition("pending_internal_review", "client_approved")).toBe(false);
  });

  it("never skips internal review", () => {
    expect(isLegalTransition("drafted", "internal_approved")).toBe(false);
    expect(isLegalTransition("drafted", "pending_client_review")).toBe(false);
    expect(isLegalTransition("drafted", "scheduled")).toBe(false);
  });

  it("never jumps straight to published", () => {
    for (const from of ALL) {
      if (from === "publishing") continue;
      expect(isLegalTransition(from, "published"), `${from} -> published`).toBe(false);
    }
  });

  it("never schedules without passing the client stage", () => {
    for (const from of ALL) {
      if (from === "client_approved" || from === "publish_failed") continue;
      expect(isLegalTransition(from, "scheduled"), `${from} -> scheduled`).toBe(false);
    }
  });

  it("treats published as terminal", () => {
    expect(legalNextStatuses("published")).toHaveLength(0);
  });

  it("rejects a transition to the same status", () => {
    for (const s of ALL) {
      expect(isLegalTransition(s, s), `${s} -> ${s}`).toBe(false);
    }
  });
});

describe("approval moves the item forward", () => {
  it("an internal approval lands at internal_approved", () => {
    const result = applyTransition("pending_internal_review", {
      cause: "approve",
      stage: "internal",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("internal_approved");
  });

  it("a client approval lands at client_approved", () => {
    const result = applyTransition("pending_client_review", {
      cause: "approve",
      stage: "client",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("client_approved");
  });

  it("refuses an approval that does not name its stage", () => {
    // Unlike a decline, where the stage does not change the outcome, an
    // approval is meaningless without knowing who gave it.
    const result = applyTransition("pending_internal_review", { cause: "approve" });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stage/i);
  });

  it("refuses a client approval before internal review has passed", () => {
    const result = applyTransition("pending_internal_review", {
      cause: "approve",
      stage: "client",
    });

    expect(result.ok).toBe(false);
  });

  it("refuses an internal approval at the client stage", () => {
    const result = applyTransition("pending_client_review", {
      cause: "approve",
      stage: "internal",
    });

    expect(result.ok).toBe(false);
  });
});

describe("P2.7b — reset on edit", () => {
  const RESETTING: ContentStatus[] = [
    "internal_approved",
    "pending_client_review",
    "client_approved",
    "scheduled",
  ];

  it("resets to drafted from internal_approved or later", () => {
    for (const from of RESETTING) {
      for (const cause of ["content_edit", "scheduled_date_change"] as TransitionCause[]) {
        expect(resetFor(from, cause), `${from} + ${cause}`).toBe("drafted");
      }
    }
  });

  it("treats a content edit and a date change identically -- no per-cause branching", () => {
    for (const from of RESETTING) {
      expect(resetFor(from, "content_edit")).toBe(resetFor(from, "scheduled_date_change"));
    }
  });

  it("does not reset an item that has not been approved yet", () => {
    // Editing a draft is just editing a draft.
    for (const from of ["drafted", "in_refinement", "pending_internal_review"] as ContentStatus[]) {
      expect(resetFor(from, "content_edit"), from).toBeNull();
    }
  });

  it("refuses to edit an item that is publishing or published", () => {
    expect(canEdit("publishing")).toBe(false);
    expect(canEdit("published")).toBe(false);
  });

  it("allows editing everywhere else", () => {
    for (const s of ALL) {
      if (s === "publishing" || s === "published") continue;
      expect(canEdit(s), s).toBe(true);
    }
  });
});

describe("P2.7c — reset on decline, symmetric", () => {
  const DECLINABLE: ContentStatus[] = [
    "pending_internal_review",
    "internal_approved",
    "pending_client_review",
    "client_approved",
    "scheduled",
  ];

  it("allows decline at every reviewable status, including after approval", () => {
    for (const s of DECLINABLE) {
      expect(canDecline(s), s).toBe(true);
    }
  });

  it("resets to drafted from every declinable status", () => {
    for (const from of DECLINABLE) {
      expect(resetFor(from, "decline"), from).toBe("drafted");
    }
  });

  it("is symmetric: the stage that declines does not change the outcome", () => {
    // A client late-revoke and a reviewer late-revoke are the same reset.
    for (const from of DECLINABLE) {
      const viaInternal = applyTransition(from, { cause: "decline", stage: "internal" });
      const viaClient = applyTransition(from, { cause: "decline", stage: "client" });

      expect(viaInternal.status, from).toBe(viaClient.status);
      expect(viaInternal.status).toBe("drafted");
    }
  });

  it("treats decline, content edit and date change as one rule", () => {
    // The architecture's "one rule, no per-cause branching", asserted directly.
    for (const from of ["internal_approved", "client_approved", "scheduled"] as ContentStatus[]) {
      const causes: TransitionCause[] = ["decline", "content_edit", "scheduled_date_change"];
      const results = causes.map((cause) => resetFor(from, cause));
      expect(new Set(results).size, from).toBe(1);
      expect(results[0]).toBe("drafted");
    }
  });

  it("stops applying once publishing or published", () => {
    for (const s of TERMINAL_FOR_DECLINE) {
      expect(canDecline(s), s).toBe(false);
      expect(resetFor(s, "decline"), s).toBeNull();
    }
  });

  it("a published post can only be taken down, never declined", () => {
    expect(canDecline("published")).toBe(false);

    const result = applyTransition("published", { cause: "decline", stage: "client" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/take.?down/i);
  });

  it("unschedules when the item was scheduled", () => {
    const result = applyTransition("scheduled", { cause: "decline", stage: "client" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("drafted");
    expect(result.unschedule).toBe(true);
  });

  it("does not ask to unschedule an item that was never scheduled", () => {
    const result = applyTransition("internal_approved", { cause: "decline", stage: "internal" });

    expect(result.ok).toBe(true);
    expect(result.unschedule).toBe(false);
  });

  it("requires both stages to clear again after a reset", () => {
    // An item that was client_approved keeps nothing: from drafted, the only
    // way forward is back through internal review.
    const after = applyTransition("client_approved", { cause: "decline", stage: "client" });
    expect(after.status).toBe("drafted");

    expect(legalNextStatuses("drafted")).toContain("pending_internal_review");
    expect(legalNextStatuses("drafted")).not.toContain("internal_approved");
    expect(legalNextStatuses("drafted")).not.toContain("client_approved");
  });
});

describe("comments never move an item", () => {
  it("has no transition cause for a comment", () => {
    // A Comment is a discussion thread. Only a formal Approval decline or a
    // deliberate edit invalidates approvals -- there must be no way to express
    // "a comment happened" as a transition.
    for (const s of ALL) {
      const result = applyTransition(s, { cause: "comment" as TransitionCause });
      expect(result.ok, s).toBe(false);
    }
  });
});

describe("applyTransition", () => {
  it("reports the resulting status on a legal move", () => {
    const result = applyTransition("drafted", { cause: "submit_for_review" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pending_internal_review");
  });

  it("refuses an illegal move and says why", () => {
    const result = applyTransition("drafted", { cause: "schedule" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("drafted"); // unchanged
    expect(result.reason).toBeTruthy();
  });

  it("refuses to publish an item that is not publishing", () => {
    const result = applyTransition("scheduled", { cause: "publish_succeeded" });
    expect(result.ok).toBe(false);
  });

  it("never mutates its input", () => {
    const from: ContentStatus = "client_approved";
    applyTransition(from, { cause: "decline", stage: "client" });
    expect(from).toBe("client_approved");
  });
});

describe("the status vocabulary", () => {
  it("matches the ERD exactly", () => {
    expect([...CONTENT_STATUSES].sort()).toEqual(
      [
        "drafted",
        "in_refinement",
        "pending_internal_review",
        "internal_approved",
        "pending_client_review",
        "client_approved",
        "scheduled",
        "declined",
        "flagged",
        "publishing",
        "published",
        "publish_failed",
      ].sort(),
    );
  });

  it("every status has a defined transition set", () => {
    for (const s of ALL) {
      expect(legalNextStatuses(s), s).toBeInstanceOf(Array);
    }
  });

  it("every legal target is itself a known status", () => {
    for (const s of ALL) {
      for (const target of legalNextStatuses(s)) {
        expect(CONTENT_STATUSES, `${s} -> ${target}`).toContain(target);
      }
    }
  });
});
