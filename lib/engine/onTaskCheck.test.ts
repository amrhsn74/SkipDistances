import { describe, it, expect, vi } from "vitest";

import {
  type OnTaskContext,
  type OnTaskJudge,
  checkOnTask,
  deterministicOnTask,
} from "./onTaskCheck";

/**
 * The asymmetry is the design: the cheap pass may only ever allow, and only the
 * model refuses. Most of what follows guards that, because getting it backwards
 * turns a cost optimisation into a filter that blocks real work.
 *
 * No network anywhere — the judge is injected.
 */

const context: OnTaskContext = {
  clientId: "CL-102",
  clientName: "Cairo Roast",
  contentForm: "post",
  platform: "instagram",
  contentBody: "Morning ritual copy.",
  campaignTitle: "Cairo Roast — Winter Ritual",
  campaignObjective: "drive weekday morning orders",
};

/** Refuses everything it is asked. Nothing on-task should reach it. */
const alwaysRefuses: OnTaskJudge = async () => ({
  on_task: false,
  reason: "judge refused",
});

const alwaysAllows: OnTaskJudge = async () => ({
  on_task: true,
  reason: "judge allowed",
});

describe("the deterministic pass", () => {
  it("accepts a prompt naming the client or its brand", () => {
    expect(deterministicOnTask("Rework this for CL-102", context)).toMatchObject({
      verdict: "on_task",
    });
    expect(deterministicOnTask("Make it sound more like Cairo Roast", context)).toMatchObject({
      verdict: "on_task",
    });
  });

  it("accepts a prompt naming the deliverable or platform", () => {
    for (const prompt of [
      "Rewrite the post",
      "Tighten the caption",
      "Make the reel punchier",
      "This is for instagram, shorten it",
    ]) {
      expect(deterministicOnTask(prompt, context), prompt).toMatchObject({
        verdict: "on_task",
      });
    }
  });

  it("is undecided rather than negative when it recognises nothing", () => {
    // The distinction this whole module rests on. "Undecided" costs a model
    // call; "off task" would refuse, and the cheap pass is never allowed to.
    const result = deterministicOnTask("Explain quantum physics to me", context);

    expect(result.verdict).toBe("undecided");
    expect(result.verdict).not.toBe("off_task");
  });

  it("has no way to express a refusal at all", () => {
    // Structural, not behavioural: every possible return is one of these two.
    for (const prompt of [
      "write my CV",
      "explain quantum physics",
      "what is the capital of France",
      "",
    ]) {
      expect(["on_task", "undecided"]).toContain(
        deterministicOnTask(prompt, context).verdict,
      );
    }
  });

  it("ignores short tokens in a client name", () => {
    // A client called "Go Fitness" must not make every prompt containing "go"
    // look on-task -- that turns a fast-path accept into a rubber stamp.
    const goFitness = { ...context, clientId: "CL-901", clientName: "Go Fitness" };

    expect(deterministicOnTask("go ahead and do it", goFitness).verdict).toBe("undecided");
    expect(deterministicOnTask("more fitness energy", goFitness).verdict).toBe("on_task");
  });
});

describe("checkOnTask", () => {
  it("costs no model call when the cheap pass recognises the prompt", async () => {
    const judge = vi.fn(alwaysRefuses);

    const verdict = await checkOnTask("Make the caption warmer", context, judge);

    expect(verdict.onTask).toBe(true);
    expect(verdict.stage).toBe("deterministic");
    // "Costs nothing further" is the actual requirement. Only a spy proves it --
    // and a refusing judge proves the fast path really did short-circuit.
    expect(judge).not.toHaveBeenCalled();
  });

  it("passes a creative prompt that names nothing, once the model allows it", async () => {
    const judge = vi.fn(alwaysAllows);

    // The false-positive case that matters. This is ordinary work phrasing: no
    // brand, no client, no deliverable. A keyword filter would block it.
    const verdict = await checkOnTask(
      "warmer, less corporate, and drop the exclamation marks",
      context,
      judge,
    );

    expect(verdict.onTask).toBe(true);
    expect(verdict.stage).toBe("model");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("refuses only on the model's judgment, and keeps its reason", async () => {
    const judge: OnTaskJudge = async () => ({
      on_task: false,
      reason: "This asks for a personal curriculum vitae.",
    });

    const verdict = await checkOnTask("write my CV please", context, judge);

    expect(verdict.onTask).toBe(false);
    expect(verdict.stage).toBe("model");
    // An Admin reviewing the flag needs to know what the model took it to be
    // about, not merely that it said no.
    expect(verdict.reason).toContain("curriculum vitae");
  });

  it("refuses nothing when the model allows everything", async () => {
    // The guard on the rule at the top of the module: with a permissive judge,
    // no prompt is refused -- which can only be true if the cheap pass never
    // refuses on its own.
    for (const prompt of [
      "write my CV",
      "explain quantum physics",
      "what is the capital of France",
      "help me debug this python script",
      "",
    ]) {
      const verdict = await checkOnTask(prompt, context, alwaysAllows);
      expect(verdict.onTask, prompt).toBe(true);
    }
  });

  it("asks the model whenever the cheap pass is undecided", async () => {
    const judge = vi.fn(alwaysRefuses);

    await checkOnTask("explain quantum physics", context, judge);

    expect(judge).toHaveBeenCalledOnce();
    const [prompt, ctx] = judge.mock.calls[0];
    expect(prompt).toBe("explain quantum physics");
    // The model needs the item's context to judge scope at all.
    expect(ctx.clientName).toBe("Cairo Roast");
  });
});
