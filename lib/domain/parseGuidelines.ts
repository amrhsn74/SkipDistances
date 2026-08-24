import fs from "node:fs";

/**
 * Parses the guideline markdown in data/guidelines into clause rows.
 *
 * Both the agency handbook and the brand guides use one line per clause:
 *
 *   **Clause 0.6 — Unknown or inactive clients.** Content is produced only ...
 *   **NF.2 — Audience.** 18-30, casual exercisers, Cairo and Alexandria ...
 *
 * clause_code is the citation vocabulary answer_key.json is graded against
 * ("0.6", "1.3", "CR.4", "NF.2"), so it is taken verbatim from the source and
 * never reformatted.
 */

export type ParsedClause = {
  clause_code: string;
  title: string;
  text: string;
};

// **<code> — <title>.** <body>
//   code:  "Clause 0.6" | "NF.2"   (the "Clause " prefix is dropped)
//   title: up to the first period that closes the bold span
// The em-dash is the separator in every source line; a hyphen is accepted too
// so a hand-edited guide does not silently drop a clause.
const CLAUSE_RE = /^\*\*(?:Clause\s+)?([0-9]+\.[0-9]+|[A-Z]{2}\.[0-9]+)\s*[—–-]\s*(.+?)\*\*\s*(.*)$/;

export function parseClauseLines(markdown: string): ParsedClause[] {
  const out: ParsedClause[] = [];

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("**")) continue;

    const m = CLAUSE_RE.exec(line);
    if (!m) continue;

    const [, code, titleRaw, body] = m;

    // CR.4's title is "Don't. Never discount." -- it contains a period, so the
    // title is everything inside the bold span, only its trailing period
    // trimmed. Splitting on the first period would truncate it.
    const title = titleRaw.replace(/\.\s*$/, "").trim();

    out.push({
      clause_code: code,
      title,
      // Keep the title in the text too: a clause like CR.4 carries meaning in
      // its title ("Never discount") that the retrieval step must see.
      text: body.trim() ? `${title}. ${body.trim()}` : title,
    });
  }

  return out;
}

export function parseGuidelineFile(filePath: string): ParsedClause[] {
  return parseClauseLines(fs.readFileSync(filePath, "utf8"));
}

/** Brand-guide title line: "# Brand Guide — NileFit (fitness app)" */
export function parseGuideHeading(filePath: string): string | null {
  const first = fs.readFileSync(filePath, "utf8").split(/\r?\n/)[0] ?? "";
  const m = /^#\s*(.+)$/.exec(first.trim());
  return m ? m[1].trim() : null;
}

// Filesystem locations live in lib/config/paths.ts -- this module parses
// clause text and does not decide where the corpus lives.
