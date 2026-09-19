// W84 — the deterministic half of "Cody adds nothing and drops nothing". A persona may reword freely,
// but every number and date in Lexi's answer is a fact from the record, so each must survive into the
// restatement verbatim. Semantic drift (a softened caveat) is past what a regex can see; that is what
// the adapter prompt and the release-time second-model review are for.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";

const pad = (n: string | number) => String(n).padStart(2, "0");
const monthNum = (name: string) => pad(MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1);

const DATE_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g, (m) => (m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`)],
  [new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), (m) => `${m[3]}-${monthNum(m[1])}-${pad(m[2])}`],
  [new RegExp(`\\b${MONTH},?\\s+(\\d{4})\\b`, "gi"), (m) => `${m[2]}-${monthNum(m[1])}`],
];

function facts(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (const [re, key] of DATE_PATTERNS) {
    rest = rest.replace(re, (...args) => {
      out.push(key(args.slice(0, -2) as unknown as RegExpExecArray));
      return " ";
    });
  }
  for (const m of rest.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) out.push(String(Number(m[0].replaceAll(",", ""))));
  return out;
}

/** Facts in `source` absent from `restated`, in source order, deduplicated. */
export function missingFacts(source: string, restated: string): string[] {
  const kept = new Set(facts(restated));
  return [...new Set(facts(source))].filter((f) => !kept.has(f));
}
