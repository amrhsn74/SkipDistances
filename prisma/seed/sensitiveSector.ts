/**
 * Re-exported from the domain layer so the seed and the engine share one
 * derivation of Clause 1.8. The rule itself lives in lib/domain/sensitiveSector.ts
 * -- dependencies point inward, and a business rule does not belong in the seed.
 */
export { isSensitiveSector, normalizeIndustry } from "../../lib/domain/sensitiveSector";
