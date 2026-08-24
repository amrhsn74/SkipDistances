import fs from "node:fs";
import path from "node:path";

import { ANSWER_KEY_FILE, BRIEFS_DIR } from "../../lib/config/paths";

/**
 * Loads the 27 evaluation briefs and their answer key.
 *
 * These are test fixtures, not seeded campaigns: the guarded engine is run
 * against them in Phase 3 (first pass) and Phase 12 (the graded evaluation),
 * so they stay as files rather than becoming rows.
 *
 * Read straight from data/ rather than a copy under tests/. A duplicated corpus
 * drifts, and a fixture that disagrees with the data the engine is graded
 * against is worse than no fixture.
 *
 * A brief is plain text with a "Key: value" header block:
 *
 *   Brief ID: B-014
 *   Client: CL-108
 *   Title: StayEasy — 'Best Hotel' Awareness Push
 *   Date: 2026-07-01
 *
 *   Objective: position StayEasy as the best hotel chain in Egypt.
 *   Audience: 28-55 domestic travellers.
 *   ...
 *
 * Parsing here is deliberately dumb -- it reads what is literally on the page.
 * Extracting meaning from a brief is analyze_brief's job (P3.2, a Gemini call);
 * doing it here would quietly pre-solve the thing the engine is graded on.
 */

export { BRIEFS_DIR, ANSWER_KEY_FILE } from "../../lib/config/paths";

export type Brief = {
  brief_id: string;
  /** Verbatim value of the "Client:" line. "not on roster" for B-026 -- the
   *  unknown-client case is a real value here, not a parse failure. */
  client_raw: string;
  /** CL-nnn if the line contains one, else null. */
  client_id: string | null;
  title: string | null;
  date: string | null;
  fields: Record<string, string>;
  /** The whole file, which is what the engine is actually given. */
  raw_text: string;
};

export type AnswerKeyEntry = {
  client_id: string | null;
  decision: "DRAFT" | "REQUEST_INFO" | "FLAG" | "REFUSE_OVERRIDE";
  violated_or_key_clause: string | null;
  expected_tools: string[];
  rationale: string;
};

const CLIENT_ID_RE = /\b(CL-\d+)\b/;

export function parseBrief(raw: string): Brief {
  const fields: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    // First occurrence wins -- a later "Notes:" mentioning "Client:" must not
    // overwrite the header value.
    if (!(key in fields)) fields[key] = m[2].trim();
  }

  const client_raw = fields["client"] ?? "";

  return {
    brief_id: fields["brief_id"] ?? "",
    client_raw,
    client_id: CLIENT_ID_RE.exec(client_raw)?.[1] ?? null,
    title: fields["title"] ?? null,
    date: fields["date"] ?? null,
    fields,
    raw_text: raw,
  };
}

export function loadBriefs(): Brief[] {
  return fs
    .readdirSync(BRIEFS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => parseBrief(fs.readFileSync(path.join(BRIEFS_DIR, f), "utf8")));
}

export function loadAnswerKey(): Record<string, AnswerKeyEntry> {
  return JSON.parse(fs.readFileSync(ANSWER_KEY_FILE, "utf8"));
}
