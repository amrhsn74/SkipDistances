import { describe, it, expect } from "vitest";

import { flagMessage } from "./flagMessages";

/**
 * A flag nobody can read is a flag nobody acts on. These assert the two
 * properties the wording exists for: it explains rather than labels, and the
 * same event reads consistently wherever it is shown.
 */

describe("what a flag says to the person who wrote the work", () => {
  it("explains the outcome and names the client whose rule it was", () => {
    const message = flagMessage("brand_violation", {
      clauseCode: "CR.4",
      clauseTitle: "Never discount",
      clientName: "Cairo Roast",
    });

    expect(message).toContain("Cairo Roast's brand guide");
    // The clause trails the explanation rather than leading it: a reader who
    // leads with a code has to look it up before the sentence means anything.
    expect(message).toContain("(Clause CR.4 — Never discount.)");
    expect(message.indexOf("Cairo Roast")).toBeLessThan(message.indexOf("CR.4"));
  });

  it("distinguishes an agency compliance rule from a client's brand guide", () => {
    // Only one of the two is negotiable with the client, so they must not read
    // the same.
    const brand = flagMessage("brand_violation", { clientName: "Cairo Roast" });
    const agency = flagMessage("compliance_violation", { clientName: "Cairo Roast" });

    expect(brand).not.toBe(agency);
    expect(agency).toContain("agency's compliance rules");
  });

  it("carries the engine's own reason when it gave one", () => {
    const message = flagMessage("brand_violation", {
      clauseCode: "CR.4",
      reason: "The copy offers 20% off.",
    });

    expect(message).toContain("The copy offers 20% off.");
  });

  it("reads as a refusal, not an accusation", () => {
    // A content flag is the engine declining to write something. The creator
    // asked for something ordinary and a rule got in the way.
    const message = flagMessage("brand_violation", { clientName: "NileFit" });

    expect(message).toContain("was not drafted");
  });

  it("still says something useful for a code it does not know", () => {
    expect(flagMessage("something_new")).toContain("flagged for a human");
  });

  it("omits the citation entirely when there is no clause", () => {
    expect(flagMessage("off_task_generation")).not.toContain("Clause");
  });
});

describe("what the same flag says to the admin", () => {
  it("reads as conduct rather than as a refusal", () => {
    // The Admin only ever sees a content flag because someone submitted past
    // it, so it is worded as the act it records.
    const admin = flagMessage("brand_violation", { clauseCode: "CR.4" }, "admin");

    expect(admin).toContain("submitted");
    expect(admin).toContain("CR.4");
  });

  it("describes the same event differently for the two audiences", () => {
    const author = flagMessage("brand_violation", {}, "author");
    const admin = flagMessage("brand_violation", {}, "admin");

    expect(author).not.toBe(admin);
  });

  it("words a governance flag as conduct for both", () => {
    // Misuse is conduct whoever reads it.
    expect(flagMessage("approval_override_attempt", {}, "admin")).toContain("skip or fake");
  });
});
