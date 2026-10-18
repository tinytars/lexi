import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  credentialStores,
  credentialsDir,
  credentialPath,
  missingCredential,
} from "../../scripts/creds-dir";

// The resolver is the half of the two-store split a cloner actually feels: they set ONE variable and
// the second store is never consulted. Precedence is the load-bearing assertion rather than the
// fallback — lexi first is what stops a value that has MOVED to the product's own store from still
// being served out of the shared one, which is the whole failure the split exists to prevent. The
// fallback is what makes the move safe to land before the deletion commit.
//
// Every case uses scratch directories. Nothing here reads a real store, so the suite passes on a
// stranger's clone that has neither.

let lexi: string;
let plover: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  lexi = mkdtempSync(join(tmpdir(), "lexi-store-"));
  plover = mkdtempSync(join(tmpdir(), "plover-store-"));
  for (const v of ["LEXI_CREDENTIALS_DIR", "PLOVER_CREDENTIALS_DIR"]) saved[v] = process.env[v];
  process.env.LEXI_CREDENTIALS_DIR = lexi;
  process.env.PLOVER_CREDENTIALS_DIR = plover;
});

afterEach(() => {
  for (const [v, was] of Object.entries(saved)) {
    if (was === undefined) delete process.env[v];
    else process.env[v] = was;
  }
  rmSync(lexi, { recursive: true, force: true });
  rmSync(plover, { recursive: true, force: true });
});

describe("credentials resolve across both stores, per file", () => {
  it("searches the product's store before the estate's", () => {
    expect(credentialStores()).toEqual([lexi, plover]);
  });

  it("resolves a file only the product's store holds", () => {
    writeFileSync(join(lexi, "only-lexi.env"), "");
    expect(credentialPath("only-lexi.env")).toBe(join(lexi, "only-lexi.env"));
  });

  // The cloner-with-one-store case, and the reason the move can land before the deletion commit: a
  // machine that has only the estate's store keeps running.
  it("resolves a file only the estate's store holds", () => {
    writeFileSync(join(plover, "only-plover.env"), "");
    expect(credentialPath("only-plover.env")).toBe(join(plover, "only-plover.env"));
  });

  it("prefers the product's store when both hold the file", () => {
    writeFileSync(join(lexi, "in-both.env"), "");
    writeFileSync(join(plover, "in-both.env"), "");
    expect(credentialPath("in-both.env")).toBe(join(lexi, "in-both.env"));
  });

  // A file being created exists in neither store, so there is nothing to search for; the only sane
  // destination is the store this product owns.
  it("sends a file no store holds to the primary, so a writer has a destination", () => {
    expect(credentialPath("not-yet.env")).toBe(join(lexi, "not-yet.env"));
    expect(credentialsDir()).toBe(lexi);
  });

  it("collapses the two stores to one when both variables name the same directory", () => {
    process.env.PLOVER_CREDENTIALS_DIR = lexi;
    expect(credentialStores()).toEqual([lexi]);
  });

  it("falls back to the standing clone paths, never to a path inside this repository", () => {
    delete process.env.LEXI_CREDENTIALS_DIR;
    delete process.env.PLOVER_CREDENTIALS_DIR;
    expect(credentialStores()).toEqual([
      join(homedir(), "PabloTech", "lexi-keys"),
      join(homedir(), "PabloTech", "plover-keys"),
    ]);
  });
});

describe("the message for a credential no store holds", () => {
  // The failure a reader meets is "it is not where I expected", and a stack trace carrying one
  // resolved path cannot tell them which of the two variables to set.
  it("names the file, every path searched and both variables", () => {
    const msg = missingCredential("gcp-oauth.env");
    expect(msg).toContain("gcp-oauth.env");
    expect(msg).toContain(join(lexi, "gcp-oauth.env"));
    expect(msg).toContain(join(plover, "gcp-oauth.env"));
    expect(msg).toContain("LEXI_CREDENTIALS_DIR");
    expect(msg).toContain("PLOVER_CREDENTIALS_DIR");
  });

  it("names each store's repository, so a reader knows which to clone", () => {
    const msg = missingCredential("org-key.json");
    expect(msg).toContain("tinytars/lexi-keys");
    expect(msg).toContain("promontory-studio/plover-keys");
  });
});

// The citations are the other half of the split, and they are what a reader or an operator actually
// acts on. Six files MOVED to lexi-keys on 2026-10-08, and a line still spelling one of them
// `$PLOVER_CREDENTIALS_DIR/<file>` is wrong in the direction that does not announce itself: a
// machine that kept a copy of the old path sources it successfully, so the stale spelling fails by
// loading an out-of-date value rather than by erroring. A text sweep derived from the tree is
// therefore the guard, the shape tests/unit/org-key-chokepoint.test.ts already uses — a new file
// cannot dodge it by being new, at the price of rewording a sentence now and then.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".svelte-kit", "coverage", ".wrangler"]);
const TEXT = /\.(ts|js|md|sh|ya?ml|json|jsonc)$|^\.gitignore$|^\.dev\.vars\.example$/;

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const full = join(dir, e.name);
    if (e.isDirectory()) return textFiles(full);
    return TEXT.test(e.name) ? [full] : [];
  });
}

// Every file the 2026-10-08 split moved out of the estate's store. `cloudflare.env`, `anthropic.env`,
// `github-release-pat.env`, `plover-autopilot-app.pem` and `npm.env` stayed and are deliberately
// absent: naming one of those under $PLOVER_CREDENTIALS_DIR is correct.
const MOVED = [
  "org-key.json",
  "org-key.passphrase",
  "health-dash.env",
  "gcp-oauth.env",
  "health-dash-web.dev.vars",
  "gmail-sa.lexitar.json",
];

// scripts/org-key.ts states in a comment that its two failures — no store on this machine, and an
// ORG_KEY_PATH pointing somewhere stale — look identical from a stack trace and have different fixes.
// It did not actually distinguish them until 2026-10-08: one message named PLOVER_CREDENTIALS_DIR
// whichever had happened, which after the split was the wrong variable for the ordinary case. The
// module resolves its path at import, so each case needs a fresh module registry.
async function loadOrgKey() {
  vi.resetModules();
  return (await import("../../scripts/org-key")).loadOrgKeyFile;
}

describe("the org key's not-found message tells the reader which fix is theirs", () => {
  afterEach(() => {
    delete process.env.ORG_KEY_PATH;
  });

  it("names both stores and both variables when no store holds the key", async () => {
    const load = await loadOrgKey();
    expect(load).toThrowError(/LEXI_CREDENTIALS_DIR/);
    expect(load).toThrowError(/PLOVER_CREDENTIALS_DIR/);
    expect(load).toThrowError(new RegExp(join(lexi, "org-key.json").replace(/[.]/g, "\\.")));
    expect(load).toThrowError(/npm run org:key/);
  });

  it("names the override alone when ORG_KEY_PATH is what is wrong", async () => {
    process.env.ORG_KEY_PATH = join(plover, "nowhere", "org-key.json");
    const load = await loadOrgKey();
    expect(load).toThrowError(/ORG_KEY_PATH/);
    expect(load).toThrowError(/nowhere/);
    // Naming the stores here would send the reader to fix the thing they did not set.
    expect(load).not.toThrowError(/LEXI_CREDENTIALS_DIR/);
  });
});

describe("nothing in the tree still cites the estate's store for a file that moved", () => {
  const files = textFiles(ROOT);

  it("finds the tree at all, so an empty sweep cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  // One spelling of that path is the truth rather than a stale citation: the resolver's own docblock,
  // which documents the fallback it implements. The exemption is the LINE and not the file, so a
  // second, genuinely stale citation in the same file is still caught.
  const describesTheFallback = (line: string) => line.includes("the fallback");
  // Both spellings, because the one a reader pastes is the second: `$VAR/file` in prose and
  // `${VAR:-$HOME/PabloTech/plover-keys}/file` in a command. A plain substring test on the first
  // passes the second, which is how a copy-paste line survived the citation sweep that found ten.
  const cites = (file: string) =>
    new RegExp(`PLOVER_CREDENTIALS_DIR(?::-[^}]*\\})?/${file.replace(/\./g, "\\.")}`);

  it.each(MOVED)("no line points at the estate's store for %s", (file) => {
    const offenders = files
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ at: `${f.slice(ROOT.length + 1)}:${i + 1}`, line }))
          .filter(({ line }) => cites(file).test(line) && !describesTheFallback(line)),
      )
      .map(({ at }) => at);
    expect(offenders).toEqual([]);
  });
});

// A blank line ends a GitHub markdown table. A pipe row outside every table renders as literal
// pipe-text — so the row is in the file, reads as present to whoever wrote it, and is invisible to the
// reader it was written for. CREDENTIALS.md's last three route-secret rows read that way on GitHub
// until 2026-10-08, a paragraph about `GOOGLE_*` having been inserted between row nine and row ten;
// plover-keys' README carries the same defect at :53 and :63, where it costs 11 of 44 inventory rows.
//
// A row's own neighbours cannot answer this, which is the first version of this test's mistake: the
// real defect put a blank line AND a paragraph between the table and the orphaned rows, so the line
// above each orphan was prose and a prev-is-blank check passed it. Whether a row is inside a table is
// a property of everything before it, so the sweep carries the state rather than looking up one line.
describe("no table row in the credential documents is orphaned outside its table", () => {
  const docs = ["CREDENTIALS.md", "VAULT.md", "AUTH.md"].map((f) => `apps/lexitar/${f}`);
  const separator = /^\|[\s:|-]+$/;

  it.each(docs)("%s", (rel) => {
    const lines = readFileSync(resolve(ROOT, rel), "utf8").split("\n");
    const orphans: string[] = [];
    let inTable = false;
    let fenced = false;
    lines.forEach((line, i) => {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced) return;
      if (line.trim() === "") {
        inTable = false;
      } else if (line.startsWith("|")) {
        // A header opens a table only when the next line is its separator; the separator itself and
        // every row after it are inside one.
        if (separator.test(lines[i + 1] ?? "") || separator.test(line)) inTable = true;
        else if (!inTable) orphans.push(`${rel}:${i + 1}`);
      }
    });
    expect(orphans).toEqual([]);
  });

  it("and the sweep found tables to judge, so a file with none cannot pass silently", () => {
    const rows = docs.reduce(
      (n, rel) => n + readFileSync(resolve(ROOT, rel), "utf8").split("\n").filter((l) => l.startsWith("|")).length,
      0,
    );
    expect(rows).toBeGreaterThan(40);
  });
});
