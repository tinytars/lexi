// RECOVERY.md's invariants, enforced: static sweeps derived from the tree (so a new file cannot dodge
// them by being new), plus the migrated schema. Behavioural ones not yet checked are listed at the bottom.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useWorkerd } from "../support/miniflare";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

const functionFiles = tsFilesUnder(resolve(ROOT, "functions"));
const rel = (f: string) => f.slice(ROOT.length + 1);

describe("I1 — the operator holds no key that opens a vault online", () => {
  // The org key unwraps any non-revoked patient's DEK; it is safe only while no request path can load it.
  it("finds the Functions tree at all, so an empty sweep cannot pass silently", () => {
    expect(functionFiles.length).toBeGreaterThan(30);
  });

  it("has no route that can load the org private key", () => {
    const offenders = functionFiles
      .filter((f) => /loadOrgPrivateKey|org-key\.json|ORG_KEY_PASSPHRASE/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("has no route that imports from scripts/, where the org key loader lives", () => {
    // Closes the door the identifiers above came through, so a rename cannot walk around it.
    const offenders = functionFiles
      .filter((f) => /from\s+["'][^"']*\/scripts\//.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("I2 — key material is shown, not sent", () => {
  const emailSrc = readFileSync(resolve(ROOT, "functions/_lib/email.ts"), "utf8");

  it("is the only module that talks to the mail provider, so this file is the whole surface", () => {
    const senders = functionFiles.filter((f) => /gmail\.googleapis\.com/.test(readFileSync(f, "utf8"))).map(rel);
    expect(senders).toEqual(["functions/_lib/email.ts"]);
  });

  it("never references long-term key material", () => {
    // The account's PERMANENT secrets: once in a mailbox, they are in that mailbox forever.
    const forbidden = ["wrappedPrivateKey", "privateKeyPkcs8", "wrappedDek", "wrappedDEK", "authHash", "kdfParams", "recoveryAuthHash"];
    const found = forbidden.filter((k) => emailSrc.includes(k));
    expect(found).toEqual([]);
  });

  it("carries no link that grants access on its own", () => {
    // A click-to-restore link would be a bearer token in an inbox.
    const links = [...emailSrc.matchAll(/\$\{opts\.origin\}([^\s"'`]*)/g)].map((m) => m[1]);
    expect(links).toEqual(["/api/auth/email/confirm?token=${encodeURIComponent(token)}"]);
  });
});

describe("I4 — a short secret is only ever accepted behind a hard limit", () => {
  // Server-side state is the only reason a code short enough to read aloud is acceptable. Checked against
  // the fully migrated schema, so a later migration cannot quietly drop it.
  const w = useWorkerd();
  let columns: string[];
  let indexes: string[];
  beforeAll(async () => {
    const cols = await w.db.prepare("PRAGMA table_info(recovery_grants)").all<{ name: string }>();
    columns = cols.results.map((c) => c.name);
    const idx = await w.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recovery_grants' AND sql IS NOT NULL").all<{ sql: string }>();
    indexes = idx.results.map((i) => i.sql);
  });

  it.each([
    ["attempts", "without a counter the code is an unlimited oracle"],
    ["expires_at", "without an expiry a code read aloud once is valid forever"],
    ["consumed_at", "without it a code is replayable, which is what makes a signed token unusable here"],
  ])("recovery_grants declares %s — %s", (column) => {
    expect(columns).toContain(column);
  });

  it("allows at most one live grant per account", () => {
    // With two live grants the attempt counter has nothing single to count against.
    expect(indexes.join("\n")).toMatch(/CREATE UNIQUE INDEX[\s\S]*recovery_grants\s*\(\s*account_id\s*\)\s*WHERE consumed_at IS NULL/);
  });
});

describe("the verifier compare has exactly one implementation", () => {
  // A compare that returns early passes every functional test and leaks the verifier by timing; one copy to audit.
  it("is defined only in _lib/verifier.ts", () => {
    const definers = functionFiles
      .filter((f) => /\bfunction (timingSafeEqualStr|sha256Base64Url)\b/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(definers).toEqual(["functions/_lib/verifier.ts"]);
  });

  it("is actually used by the routes that check a stored verifier", () => {
    // The other direction: inlining (rather than redefining) would pass the check above.
    const importers = functionFiles
      .filter((f) => /from\s+["'][^"']*\/verifier["']/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(importers.length).toBeGreaterThanOrEqual(6);
  });
});

describe("invariants that cannot be checked statically", () => {
  it("names them, so 'documented' and 'enforced' do not quietly diverge", () => {
    const pending = {
      I3: "every path ends in something the user controls — Phase D route tests",
      I5: "enforced for rung 1 by recovery-set-password.test.ts; rung 2 in Phase D",
      I6: "a recovery method exists before there is data to lose — DEVIATION, minting stays on-demand",
    };
    expect(Object.keys(pending)).toEqual(["I3", "I5", "I6"]);
  });
});
