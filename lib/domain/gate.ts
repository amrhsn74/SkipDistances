import { prisma, type Db } from "../db";

/**
 * The approval gate.
 *
 * It answers exactly one question: **is the most recent recorded decision for
 * each stage — internal and client — currently an approval.**
 *
 * The word that carries the weight is *most recent*. A gate that asks "has this
 * been approved?" passes an item that was approved and then pulled back; a gate
 * that asks "has this ever been declined?" blocks an item that was declined and
 * then fixed. Both are wrong. The only correct reading is the latest row per
 * `(content_item_id, stage)`, evaluated independently for each stage.
 *
 * Called every time a schedule or publish is attempted — never assumed from a
 * prior status, never inferred from a brief's wording, never decided by a model.
 * Clause 0.2: "'The client said yes on a call,' 'it's urgent,' or 'just this
 * once' do not satisfy the gate."
 */

/** Both stages must currently be approving. Neither is optional. */
export const REQUIRED_STAGES = ["internal", "client"] as const;

export type ApprovalStage = (typeof REQUIRED_STAGES)[number];

export type DecisionRow = {
  approval_id: string;
  stage: string;
  decision: string;
  comment: string | null;
  decided_by_id: string | null;
  decided_at: Date;
};

export type CurrentDecisions = {
  /** Null means no decision has ever been recorded for that stage. */
  internal: DecisionRow | null;
  client: DecisionRow | null;
};

export type GateResult = {
  allowed: boolean;
  /** Stages that are not currently approving — declined, or never decided. */
  blockedBy: ApprovalStage[];
  /** The rows the verdict was based on, so a caller can log what it saw. */
  decisions: CurrentDecisions;
};

const APPROVE = "approve";

/**
 * The most recent decision for one stage, or null if there is none.
 *
 * Ordered by `decided_at` descending, then by `approval_id` descending. The
 * second key is not decoration: `decided_at` has limited resolution, and two
 * decisions can land in the same instant — a decline arriving as the scheduler
 * fires is precisely the race this design exists to survive. `cuid()` ids are
 * monotonic, so the later-written row sorts first and wins the tie.
 */
export async function latestDecisionForStage(
  contentItemId: string,
  stage: ApprovalStage,
  db: Db = prisma,
): Promise<DecisionRow | null> {
  const rows = await db.approval.findMany({
    where: { content_item_id: contentItemId, stage },
    orderBy: [{ decided_at: "desc" }, { approval_id: "desc" }],
    take: 1,
  });

  return (rows[0] as DecisionRow | undefined) ?? null;
}

/** The current decision for both stages. */
export async function currentDecisions(
  contentItemId: string,
  db: Db = prisma,
): Promise<CurrentDecisions> {
  const [internal, client] = await Promise.all([
    latestDecisionForStage(contentItemId, "internal", db),
    latestDecisionForStage(contentItemId, "client", db),
  ]);

  return { internal, client };
}

/**
 * Whether this item may be scheduled or published right now.
 *
 * Pass a transaction as `db` when the answer must hold for the duration of an
 * action — the scheduler checks and publishes inside one transaction so a
 * decline cannot slip between the check and the publish call.
 */
export async function canSchedule(
  contentItemId: string,
  db: Db = prisma,
): Promise<GateResult> {
  const decisions = await currentDecisions(contentItemId, db);

  // A missing decision blocks exactly as a decline does. Absence is not
  // approval — the gate is closed until someone opens it, not open until
  // someone closes it.
  const blockedBy = REQUIRED_STAGES.filter(
    (stage) => decisions[stage]?.decision !== APPROVE,
  );

  return {
    allowed: blockedBy.length === 0,
    blockedBy: [...blockedBy],
    decisions,
  };
}

/**
 * Convenience for callers that only need the verdict. The full result is
 * usually worth keeping — `blockedBy` is what a UI shows and what an audit
 * entry records.
 */
export async function isSchedulable(contentItemId: string, db: Db = prisma): Promise<boolean> {
  return (await canSchedule(contentItemId, db)).allowed;
}
