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
// Two things it deliberately does not do. It does not check `:line` suffixes — a line number goes
// stale on an unrelated edit, and a gate demanding them teaches people to delete the citation
// rather than fix it. And it does not exempt a file by pattern: every tolerated citation is named
// one by one in KNOWN with its reason, which is narrower than exempting a document.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// Every citation that does not resolve, with the reason it is tolerated. Two kinds, and they are
// told apart by the reason rather than by a second list: an entry whose reason begins `Phase 2 —`
// is a repair this phase did not reach and the next one owes; every other entry is permanent and
// says why the citation is correct as written. Nothing is exempted by pattern — a document is never
// skipped, only a citation named here one at a time.
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

  // History: a document recording what was removed cannot be written without naming it.
  "apps/lexitar/BACKUP.md | tip-watch.yml": "names the workflow that was deleted; that is the record",
  "apps/lexitar/docs/BUILDING.md | .github/workflows/tip-watch.yml": "as above",
  "apps/lexitar/docs/E2E-HISTORY.md | middleware-ensure-req-body-drained.ts": "a history of deleted middleware, by name",

  // Notation, not a path or a script.
  ".claude/agents/health-dash-explorer.md | path:line": "how a citation is to be written, not a command",
  ".claude/agents/health-dash-implementer.md | file:line": "as above",
  "apps/lexitar/docs/BUILDING.md | file:line": "as above",
  "apps/lexitar/LINTING.md | bind:this": "a Svelte directive",

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

  // Phase 2 — the sweep this phase's gate makes safe to defer. Each needs its real successor
  // identified from the code, which for VAULT.md's eighteen is reading rather than renaming.
  ".claude/agents/health-dash-explorer.md | finding-assemble.ts": "Phase 2 — moved into @pablotech/akesi",
  ".claude/agents/health-dash-explorer.md | finding-generate.ts": "Phase 2 — moved into @pablotech/akesi",
  ".claude/agents/health-dash-explorer.md | treatment-bucket.ts": "Phase 2 — moved into @pablotech/akesi",
  ".claude/agents/health-dash-explorer.md | treatment-normalize.ts": "Phase 2 — moved into @pablotech/akesi",
  "apps/lexitar/AUTH.md | _lib/guard.ts:31": "Phase 2 — mis-rooted; guard.ts exists elsewhere",
  "apps/lexitar/AUTH.md | scripts/set-recovery-code.ts": "Phase 2 — deleted; find what issues a recovery code now",
  "apps/lexitar/AUTH.md | vault:build": "Phase 2 — deleted script",
  "apps/lexitar/AUTH.md | vault:verify": "Phase 2 — deleted script",
  "apps/lexitar/BLOOD.md | ranges.ts:7": "Phase 2 — deleted; the staleness check moved",
  "apps/lexitar/BLOOD.md | src/lib/ranges.ts": "Phase 2 — deleted",
  "apps/lexitar/BLOOD.md | src/lib/status.ts": "Phase 2 — deleted",
  "apps/lexitar/CREDENTIALS.md | vault:verify": "Phase 2 — deleted script",
  "apps/lexitar/DEXA.md | status.ts": "Phase 2 — deleted",
  "apps/lexitar/docs/BUILDING.md | CLAUDE.md": "Phase 2 — the root policy document is START-HERE.md",
  "apps/lexitar/INGEST.md | src/lib/crypto.ts": "Phase 2 — deleted",
  "apps/lexitar/INGEST.md | src/lib/imaging-catalog.ts": "Phase 2 — deleted",
  "apps/lexitar/INGEST.md | src/lib/ingest-core.ts": "Phase 2 — deleted",
  "apps/lexitar/INGEST.md | vault:verify": "Phase 2 — deleted script",
  "apps/lexitar/LINTING.md | _migrate.ts": "Phase 2 — deleted",
  "apps/lexitar/NARRATIVE.md | imaging-catalog.ts": "Phase 2 — deleted",
  "apps/lexitar/NARRATIVE.md | scripts/report-merge.ts": "Phase 2 — now @pablotech/akesi/report-merge",
  "apps/lexitar/NARRATIVE.md | src/lib/imaging-catalog.ts": "Phase 2 — deleted",
  "apps/lexitar/NARRATIVE.md | src/lib/parsers/report.ts": "Phase 2 — mis-rooted; report.ts exists elsewhere",
  "apps/lexitar/VAULT.md | functions/_lib/identity.ts:446": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | npm run roster:rotate": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | npm run vault:build": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | npm run vault:verify": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | recovery:issue": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | scripts/migrate-accounts.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | scripts/processed-store.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | scripts/vault-build.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | scripts/vault-io.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | scripts/vault-verify.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | scripts/vault-watch.sh": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | src/lib/auth-client.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | src/lib/crypto.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | src/lib/ExportTab.svelte": "Phase 2 — mis-rooted; ExportTab.svelte exists elsewhere",
  "apps/lexitar/VAULT.md | src/lib/report-merge.ts": "Phase 2 — now @pablotech/akesi/report-merge",
  "apps/lexitar/VAULT.md | src/lib/vault-sink.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | tests/unit/vault-integrity.test.ts": "Phase 2 — deleted",
  "apps/lexitar/VAULT.md | vault:build": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | vault:verify": "Phase 2 — deleted script",
  "apps/lexitar/VAULT.md | vault.json": "Phase 2 — the plaintext the deleted vault:build encrypted; goes with that prose",
  "ARCHITECTURE.md | inference/openai.ts": "Phase 2 — mis-rooted; openai.ts exists elsewhere",
  "ARCHITECTURE.md | vault:verify": "Phase 2 — deleted script",
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
});
