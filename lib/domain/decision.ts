/**
 * The decision vocabulary every guarded step speaks.
 *
 * These four outcomes are the ones answer_key.json grades against, so they are
 * modelled exactly and not paraphrased:
 *
 *   DRAFT            complete, compliant -> generate the plan and queue it
 *   REQUEST_INFO     required fields missing, or a claim needs substantiation
 *   FLAG             conflicts with the brand guide, compliance rules, or roster
 *   REFUSE_OVERRIDE  the brief tries to skip or fake approvals
 *
 * Every non-DRAFT outcome names the clause it came from. That is the PRD's
 * "grounded, cited output" requirement expressed as a type: a step cannot
 * refuse or hold something without saying which rule it worked from.
 */

export type Decision = "DRAFT" | "REQUEST_INFO" | "FLAG" | "REFUSE_OVERRIDE";

/** Flag.flag_type in the ERD. */
export type FlagType =
  | "brand_violation"
  | "compliance_violation"
  | "unknown_client"
  | "inactive_client"
  | "cross_client_data"
  | "approval_override_attempt";

export type Ok<T> = {
  decision: "DRAFT";
  value: T;
};

export type RequestInfo = {
  decision: "REQUEST_INFO";
  /** The clause requiring the information -- "0.5" (missing fields) or "1.3"
   *  (an unsubstantiated superlative). */
  clauseCode: string;
  /** Named so the account manager knows exactly what to supply. */
  missing: string[];
  reason: string;
};

export type Flagged = {
  decision: "FLAG";
  clauseCode: string;
  flagType: FlagType;
  reason: string;
};

export type RefusedOverride = {
  decision: "REFUSE_OVERRIDE";
  clauseCode: string;
  reason: string;
  /** The brief wording that tripped it, for the human who reviews the flag. */
  matches: string[];
};

export type Outcome<T> = Ok<T> | RequestInfo | Flagged | RefusedOverride;

export const ok = <T>(value: T): Ok<T> => ({ decision: "DRAFT", value });

export const requestInfo = (
  clauseCode: string,
  missing: string[],
  reason: string,
): RequestInfo => ({ decision: "REQUEST_INFO", clauseCode, missing, reason });

export const flag = (
  clauseCode: string,
  flagType: FlagType,
  reason: string,
): Flagged => ({ decision: "FLAG", clauseCode, flagType, reason });

export const refuseOverride = (
  clauseCode: string,
  reason: string,
  matches: string[],
): RefusedOverride => ({
  decision: "REFUSE_OVERRIDE",
  clauseCode,
  reason,
  matches,
});

export const isOk = <T>(o: Outcome<T>): o is Ok<T> => o.decision === "DRAFT";
