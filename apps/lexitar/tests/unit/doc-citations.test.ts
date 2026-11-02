// A document that prints a path is making a claim a reader will act on: they will open it. When the
// file moves or goes away the sentence stays, reads as current, and the reader has no way to tell
// which of the document's other claims are of the same vintage. This repository is public and its
// root README sends strangers to INGEST.md, so the cost is paid by every one of them once.
//
// This is the gate rather than the sweep. The sweep is a one-off and these documents have already
// had one; what was missing is anything watching, so the deletion that orphans the next citation
// fails here instead of being found by a reader. Derived in the shape store-key-classes.test.ts
// established and a11y-static.test.ts argues for: the citations come out of the documents and the
// resolution out of the tree, so a NEW violation trips it without anyone editing this file.
//
// Two things it deliberately does not do. It does not ask whether line N is still the RIGHT line —
// that goes stale on an unrelated edit, and a gate demanding it teaches people to delete the
// citation rather than fix it. It does ask whether the file has N lines at all, in the third test
// below, which no edit can make wrong. And it does not exempt a file by pattern: every tolerated
// citation is named one by one in KNOWN with its reason, which is narrower than exempting a
// document.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Tracked, not walked: an untracked scratch document on one machine would otherwise fail CI
// nowhere and fail here for one person, which is the opposite of a gate.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const docs = tracked.filter((p) => p.endsWith(".md"));
const basenames = new Set(tracked.map((p) => p.slice(p.lastIndexOf("/") + 1)));

// A backticked span is a citation when it looks like a path AND its extension is one this
// repository actually tracks. Without the extension list, `0.1.58`, `literacy.tinytars.foundation`
// and `Dag.addNode` all read as paths. `.env` and `.vars` are deliberately absent: a credential
// file is never tracked, so "does it resolve" is not a question about this repository, and making
// CREDENTIALS.md fail for naming the next secret would teach people to stop naming them.
const EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "svelte", "md", "json", "jsonc", "sh", "bash", "yml", "yaml",
  "sql", "css", "html", "toml", "py", "txt", "lock", "png", "svg", "ico",
]);

// The four roots a path in a LexiTar document can sensibly be written against.
const roots = (docRel: string) => [
  join(ROOT, dirname(docRel)),
  ROOT,
  join(ROOT, "apps", "lexitar"),
  join(ROOT, "packages", "frame"),
];

const scripts = new Set(
  tracked
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .flatMap((p) => Object.keys(JSON.parse(readFileSync(join(ROOT, p), "utf8")).scripts ?? {})),
);

type Violation = { key: string; why: string };

function sweep(): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  const add = (docRel: string, cite: string, why: string) => {
    const key = `${docRel} | ${cite}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, why });
  };

  for (const docRel of docs) {
    const text = readFileSync(join(ROOT, docRel), "utf8");

    for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
      const m = /^([A-Za-z0-9._@/-]+?)(?::\d+(?:-\d+)?)?$/.exec(span);
      if (!m) continue;
      const path = m[1];
      // A dot-leading bare name is a suffix convention under discussion (`.svelte.ts`) or an
      // untracked local file (`.dev.vars`), not a path anybody is being sent to open.
      if (path.startsWith(".") && !path.includes("/")) continue;
      const base = path.slice(path.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      if (dot <= 0) continue;
      if (!EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) continue;

      if (path.includes("/")) {
        if (roots(docRel).some((r) => existsSync(join(r, path)))) continue;
        // A path that resolves nowhere but whose basename exists is mis-rooted rather than dead,
        // and the two want different repairs.
        add(docRel, span, basenames.has(base) ? `mis-rooted: ${base} exists elsewhere` : "no such file");
      } else if (!basenames.has(base)) {
        add(docRel, span, "no file of that name anywhere in the tree");
      }
    }

    for (const [, name] of text.matchAll(/npm run ([a-z0-9][a-z0-9:_-]*)/g)) {
      if (!scripts.has(name)) add(docRel, `npm run ${name}`, "no package.json declares that script");
    }

    // A backticked `vault:verify` is the same claim as `npm run vault:verify` and was the half the
    // regex above missed: four of this repository's documents name a deleted script that way and
    // none of them says "npm run". A `node:` specifier is excluded by definition rather than by
    // exemption — `node:sqlite` is an import, not a script anybody can run.
    for (const [, name] of text.matchAll(/`((?!node:)[a-z][a-z0-9-]*:[a-z][a-z0-9:-]*)`/g)) {
      if (!scripts.has(name)) add(docRel, name, "backticked like a script, and no package.json declares one");
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// Every citation that does not resolve, with the reason it is correct as written. One kind now:
// there is no deferred-repair tier any more, so an entry here is a claim that the citation is right
// and the checker is the one that cannot see it — which is a claim somebody can disagree with, and
// that is the point of the reason being required. Nothing is exempted by pattern: a document is
// never skipped, only a citation named here one at a time.
//
// It is held in both directions. The second test below asserts that every key still fails, so an
// entry whose subject comes back — a script re-declared, a file restored — breaks the build rather
// than sitting here silently excusing a citation that no longer needs it.
const KNOWN: Record<string, string> = {
  // Deliberate references to something that is NOT in this repository, and could not be.
  ".claude/agents/health-dash-explorer.md | ingest.ts":
    "the brief's own point: these are the files that never moved here, named so the agent stops looking",
  ".claude/agents/health-dash-explorer.md | vault-io.ts": "same sentence as ingest.ts above",
  ".claude/agents/health-dash-gatekeeper.md | gate.yml": "another repository's workflow, named as a topology this one deliberately lacks",
  "apps/lexitar/MEASUREMENT.md | METHOD.md": "dokimasia-rk's document, linked by URL rather than cited as a local path",
  "apps/lexitar/MEASUREMENT.md | pilos/CONTRIBUTING.md": "pablo-tech/pilos, another repository",
  "apps/lexitar/VAULT.md | planning/lexi/remediate-published-key-material.md": "plans live in the context repository, never in the repository they plan for",
  "apps/lexitar/docs/adr/0001-rewrite-applied-migration-0002.md | planning/lexi/remediate-published-key-material.md": "as above",
  "apps/lexitar/VAULT.md | npm run roster:rotate":
    "the row's own finding: the rotation CLI stayed in plover-code, and saying so is the point of the sentence",

  // History: a document recording what was removed cannot be written without naming it.
  "apps/lexitar/BACKUP.md | tip-watch.yml": "names the workflow that was deleted; that is the record",
  "apps/lexitar/docs/BUILDING.md | .github/workflows/tip-watch.yml": "as above",
  "apps/lexitar/docs/E2E-HISTORY.md | middleware-ensure-req-body-drained.ts": "a history of deleted middleware, by name",
  "apps/lexitar/AUTH.md | scripts/set-recovery-code.ts":
    "the sentence says it no longer exists and when it stopped; naming it is what makes the record readable",

  // Notation, not a path or a script.
  ".claude/agents/health-dash-explorer.md | path:line": "how a citation is to be written, not a command",
  ".claude/agents/health-dash-implementer.md | file:line": "as above",
  "apps/lexitar/docs/BUILDING.md | file:line": "as above",
  "apps/lexitar/LINTING.md | bind:this": "a Svelte directive",
  "apps/lexitar/VAULT.md | recovery:issue":
    "a capability string in functions/_lib/capabilities.ts, shaped like a script name and run by nobody",

  // Runtime artifacts and credentials: generated or supplied at run time, tracked nowhere by design.
  "apps/lexitar/AUTH.md | org-key.json": "an operator artifact, never committed",
  "apps/lexitar/AUTH.md | roster.json": "generated into the store at run time",
  "apps/lexitar/BACKUP.md | latest.json": "written by the snapshot, not by anybody here",
  "apps/lexitar/BACKUP.md | records/org-key.json": "the operator artifact's path in the store, not in the tree",
  "apps/lexitar/CREDENTIALS.md | gmail-sa.lexitar.json": "a service-account key — it lives in tinytars/lexi-keys and must never be here",
  "apps/lexitar/CREDENTIALS.md | org-key.json": "as AUTH.md above",
  "apps/lexitar/docs/OPS-LOCAL.md | org-key.json": "as above",
  "apps/lexitar/docs/RECORD-EXPORT.md | manifest.json": "a member of the export archive this document specifies",
  "apps/lexitar/docs/RECORD-EXPORT.md | record.json": "as above",
  "apps/lexitar/VAULT.md | manifest.json": "a member of a snapshot, as RECORD-EXPORT.md above",
  "apps/lexitar/VAULT.md | org-key.json": "as AUTH.md above",
  "apps/lexitar/VAULT.md | record.json": "as RECORD-EXPORT.md above",
  "apps/lexitar/VAULT.md | records/org-key.json": "as BACKUP.md above",
};

describe("documented paths and commands", () => {
  const violations = sweep();

  it("every citation resolves, or is named in KNOWN", () => {
    const unlisted = violations.filter((v) => !(v.key in KNOWN)).map((v) => `${v.key}  (${v.why})`);
    expect(unlisted).toEqual([]);
  });

  // The other direction, and the half that makes this a ratchet rather than a floor: repairing a
  // citation without delisting it leaves an entry nothing holds, and the next reader takes the
  // list as the inventory of what is broken. scripts/coverage-ratchet.ts treats a removed key the
  // same way, as a lowered floor.
  it("KNOWN names no citation that now resolves", () => {
    const live = new Set(violations.map((v) => v.key));
    expect(Object.keys(KNOWN).filter((k) => !live.has(k))).toEqual([]);
  });

  // The `:line` suffix, and the ONE question about it that no unrelated edit can turn stale: does
  // the file have that many lines? The header above refuses to check that line N is still the right
  // line, and that refusal stands -- it would fail on every edit above a citation and teach people
  // to drop the suffix. This is the floor under it rather than an exception to it: a citation past
  // the end of its file was wrong when it was written or wrong when the file shrank, is wrong under
  // every subsequent edit, and lands the reader nowhere. Three were merged by the sweep that emptied
  // KNOWN -- `src/lib/types.ts:121` in a 29-line file, `scripts/claude-finding.ts:888` in a 44-line
  // one, and a range overshooting its handler's end -- all three naming code that had moved into
  // `@pablotech/akesi`, which is what a dead line number usually means and what the path check alone
  // cannot see.
  it("every line-numbered citation points inside its file", () => {
    const past: string[] = [];
    for (const docRel of docs) {
      for (const [, span] of readFileSync(join(ROOT, docRel), "utf8").matchAll(/`([^`\n]+)`/g)) {
        const m = /^([A-Za-z0-9._@/-]+?):(\d+)(?:-(\d+))?$/.exec(span);
        if (!m) continue;
        const [, path, first, last] = m;
        const hit = roots(docRel)
          .map((r) => join(r, path))
          .find((f) => existsSync(f) && statSync(f).isFile());
        if (!hit) continue; // not a path into this repository; the tests above own that question
        // Minus the empty string after a trailing newline, or `:97` of a 96-line file passes.
        const body = readFileSync(hit, "utf8");
        const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
        const want = Number(last ?? first);
        if (want > lines) past.push(`${docRel} | ${span}  (the file has ${lines} lines)`);
      }
    }
    expect(past).toEqual([]);
  });
});
