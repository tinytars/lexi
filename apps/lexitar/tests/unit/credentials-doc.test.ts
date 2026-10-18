// CREDENTIALS.md is the one place that says which secrets exist, where each belongs and what a
// clone can run without them — so it is the one document whose going stale is indistinguishable
// from being right. This suite is what stops that, by checking it against the code in both
// directions rather than by anyone remembering to.
//
// Comments are blanked rather than deleted, the way tests/unit/org-key-chokepoint.test.ts does it:
// without that, a variable named only in a sentence describing what it USED to open reads as a
// live reader of it, which is exactly the confusion the "measured dead" table exists to end.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = readFileSync(join(APP, "CREDENTIALS.md"), "utf8");
const ENV_NAME = /\b[A-Z][A-Z0-9_]{3,}\b/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const blankComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

// inference.config.json is a sweep root in its own right, and has to be: it is the file that
// decides which env var each feature's provider reads, so FINDING_ANTHROPIC_API_KEY and
// RANGES_ANTHROPIC_API_KEY are named there and resolved dynamically at
// functions/_lib/inference/resolve.ts:33 rather than written into any route.
const sources = [
  ...["src", "functions", "scripts", "server"].flatMap((d) => tsFiles(join(APP, d))).map((f) => blankComments(readFileSync(f, "utf8"))),
  readFileSync(join(APP, "inference.config.json"), "utf8"),
];
const inCode = new Set(sources.flatMap((s) => s.match(ENV_NAME) ?? []));

// A table's first column, which is the name being inventoried. The rest of a row is prose about
// it and may legitimately mention a different variable — the dead table's rows name the live
// secret each dead copy used to stand for, and those are not claims about the dead name.
const firstColumn = (section: string) =>
  section
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .flatMap((l) => l.split("|")[1].match(ENV_NAME) ?? []);

const between = (from: string, to: string) => DOC.slice(DOC.indexOf(from), DOC.indexOf(to));

const live = [
  ...firstColumn(between("## Route secrets", "## Operator artifacts")),
  ...firstColumn(between("## Operator artifacts", "## Measured dead")),
];
const dead = firstColumn(between("## Measured dead", "## Configuration that is not a secret"));
const routeNames = firstColumn(between("## Route secrets", "## Operator artifacts"));
const setupNames = firstColumn(between("## Standing this up from a clone", "## Preflight"));
const templateNames = [
  ...readFileSync(join(APP, ".dev.vars.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm),
].map((m) => m[1]);

describe("CREDENTIALS.md is checked against the code in both directions", () => {
  it("finds the document and both of its tables, so an empty sweep cannot pass silently", () => {
    expect(live.length).toBeGreaterThan(20);
    expect(dead.length).toBe(6);
  });

  it("inventories no secret the code does not read", () => {
    expect(live.filter((n) => !inCode.has(n))).toEqual([]);
  });

  // The other direction, and the one that catches a resurrection: a name in this table is a
  // measured claim that nothing reads it. Wire one back in and this fails, which is the only way
  // the claim stays true after the day it was measured.
  it("still finds nothing reading the six names it reports as dead", () => {
    expect(dead.filter((n) => inCode.has(n))).toEqual([]);
  });

  it("omits no secret .dev.vars.example names, which is the template a reader copies from", () => {
    expect(templateNames.length).toBeGreaterThan(10);
    expect(templateNames.filter((n) => !DOC.includes(`\`${n}\``))).toEqual([]);
  });

  // THE DIRECTION THAT WAS MISSING, AND WHAT IT COST. The assertion above catches a name in the
  // template that the document never mentions. Nothing caught the reverse — a secret this document
  // inventories that the template omits — and the reverse is the one a cloner meets: they copy
  // .dev.vars.example, fill in every line, and the application is still missing five secrets that
  // both deployed environments carry. Measured on 2026-10-08, before this ran: AZURE_SPEECH_KEY,
  // AZURE_SPEECH_REGION, GMAIL_SA_CLIENT_EMAIL, GMAIL_SA_PRIVATE_KEY and GMAIL_SENDER were all
  // inventoried here and absent there. A commented line counts — the template's own convention is
  // that an optional or account-specific value ships commented out — so what this forbids is
  // silence, not a blank value.
  //
  // EMAIL_FROM is the one exception and is asserted rather than skipped, because an exception
  // nobody has to justify is how the next four get added.
  it("names in the template every route secret it inventories", () => {
    const missing = routeNames.filter((n) => !templateNames.includes(n));
    expect(missing).toEqual(["EMAIL_FROM"]);
    expect(DOC).toContain("functions/_lib/email.ts:107");
  });

  // The setup table answers "where does this value come from" for each secret, which is the
  // question a cloner actually has. It is a second list, so it can disagree with the first: this
  // holds it to naming only real secrets that the template also carries, rather than to being
  // complete, because two of the nineteen are deliberately described in a sibling's prose.
  it("sources only real secrets in the setup table", () => {
    expect(setupNames.length).toBeGreaterThan(12);
    expect(setupNames.filter((n) => !inCode.has(n))).toEqual([]);
    expect(setupNames.filter((n) => !templateNames.includes(n))).toEqual([]);
  });
});
