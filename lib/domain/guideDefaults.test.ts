import { describe, it, expect } from "vitest";

import { guideDefaults, type GuideClause } from "./guideDefaults";

/**
 * These tests are about one thing: the engine must not ask a creator for
 * something the client's own guide already states. The clauses below are the
 * seeded corpus's real wording.
 */

function brand(clause_code: string, title: string, text: string): GuideClause {
  return { clause_code, title, text, source_type: "brand" };
}

const CAIRO_ROAST: GuideClause[] = [
  brand("CR.1", "Voice", "Voice. Warm, artisanal, unhurried; storytelling about origin and craft."),
  brand(
    "CR.2",
    "Audience",
    "Audience. 25-45 professionals who treat coffee as a ritual, premium buyers.",
  ),
];

describe("reading Clause 0.5 fields out of a brand guide", () => {
  it("takes the audience from the guide's own audience clause", () => {
    const defaults = guideDefaults(CAIRO_ROAST);

    expect(defaults.audience).toEqual({
      value: "25-45 professionals who treat coffee as a ritual, premium buyers.",
      clauseCode: "CR.2",
    });
  });

  it("reads channels named inside the audience clause", () => {
    // Layla states its channels where the guides actually put them.
    const defaults = guideDefaults([
      brand("LF.2", "Audience", "Audience. Women 16-28, trend-driven, Instagram and TikTok first."),
    ]);

    expect(defaults.channels?.value).toBe("instagram, tiktok");
    expect(defaults.channels?.clauseCode).toBe("LF.2");
  });

  it("keeps the order the clause names the channels in", () => {
    const defaults = guideDefaults([
      brand("TN.2", "Audience", "Audience. Operations and IT managers; LinkedIn is the primary channel."),
    ]);

    expect(defaults.channels?.value).toBe("linkedin");
  });

  it("leaves channels unanswered when the guide names none", () => {
    // Cairo Roast's guide states an audience but no channel, so the channel is
    // a real question and must stay one.
    expect(guideDefaults(CAIRO_ROAST).channels).toBeUndefined();
  });

  it("never answers the objective -- a guide cannot know what this campaign is for", () => {
    expect(guideDefaults(CAIRO_ROAST).objective).toBeUndefined();
  });

  it("ignores agency clauses, which say nothing about one brand's audience", () => {
    const agency: GuideClause[] = [
      {
        clause_code: "0.5",
        title: "Incomplete briefs",
        text: "Incomplete briefs. A brief must state the client, the objective, the target audience, and the channels.",
        source_type: "agency",
      },
    ];

    expect(guideDefaults(agency)).toEqual({});
  });

  it("returns nothing for a client with no brand guide", () => {
    expect(guideDefaults([])).toEqual({});
  });
});
