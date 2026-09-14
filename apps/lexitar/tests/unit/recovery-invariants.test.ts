// W73 Phase B — the recovery invariants in RECOVERY.md, enforced rather than asserted.
//
// The point of writing a standard down is that we notice when we drift from it, and a document nobody
// checks is not a standard — it is a wish. This file is the checking. It deliberately lands BEFORE the
// recovery routes so the invariants constrain the implementation instead of describing whatever got
// built, which is the failure mode RECOVERY.md itself fell into: it opened with "nothing is ever locked
// behind a key you could lose", which stopped being true the day W44 shipped, and nobody noticed for a
// year because nothing checked.
//
// Static source sweeps, in the manner of `credential-free-imports.test.ts` and
// `erasure-completeness.test.ts`: no bundler, no runtime import, and the expectation is derived from
// the tree rather than hand-listed, so a new file cannot dodge it by being new.
//
// Some invariants are behavioural and cannot be checked statically. Those are named at the bottom with
// the phase that brings them, so the gap between "documented" and "enforced" is itself visible.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  // The org recovery envelope can unwrap any non-revoked patient's DEK. It is safe only because the
  // private key lives in records/org-key.json under a passphrase that exists on an operator's machine
  // and NOWHERE a request can reach. The day a route can load it, the central claim in SECURITY.md
  // ("the operator cannot read a patient's record") becomes false — not weakened, false — and the
  // change that did it would look like a one-line import.
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
    // The narrower check above names three identifiers; this one closes the door they came through, so
    // a rename cannot walk around it.
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
    // If someone writes a template that mails a wrapped key, an authHash, or a DEK, it has to name one
    // of these. The list is the account's PERMANENT secrets — the things that, once in a mailbox, are
    // in that mailbox forever.
    const forbidden = ["wrappedPrivateKey", "privateKeyPkcs8", "wrappedDek", "wrappedDEK", "authHash", "kdfParams", "recoveryAuthHash"];
    const found = forbidden.filter((k) => emailSrc.includes(k));
    expect(found).toEqual([]);
  });

  it("carries no link that grants access on its own", () => {
    // The one link that exists confirms an email address and grants nothing. A recovery flow that
    // mailed a click-to-restore link would be a bearer token in an inbox.
    const links = [...emailSrc.matchAll(/\$\{opts\.origin\}([^\s"'`]*)/g)].map((m) => m[1]);
    expect(links).toEqual(["/api/auth/email/confirm?token=${encodeURIComponent(token)}"]);
  });
});

describe("I4 — a short secret is only ever accepted behind a hard limit", () => {
  // A code a clinician can read down a phone line cannot also be long enough to survive an online
  // guessing oracle. Apple resolves that with HSMs that destroy the escrow record after ten tries; the
  // equivalent here is server-side state, which means these columns are not conveniences — they are the
  // only reason a short code is acceptable at all. Asserted against the migration because the schema is
  // what makes the guarantee possible; the behaviour is asserted in Phase D.
  const migration = readFileSync(resolve(ROOT, "migrations/0009_recovery_grants.sql"), "utf8");

  it.each([
    ["attempts", "without a counter the code is an unlimited oracle"],
    ["expires_at", "without an expiry a code read aloud once is valid forever"],
    ["consumed_at", "without it a code is replayable, which is what makes a signed token unusable here"],
  ])("recovery_grants declares %s — %s", (column) => {
    expect(migration).toMatch(new RegExp(`^\\s*${column}\\b`, "m"));
  });

  it("allows at most one live grant per account", () => {
    // Two live grants make "which grant did this attempt belong to" ambiguous, so the attempt counter
    // stops meaning anything — the cap is only real if there is one thing to count against.
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*recovery_grants\(account_id\)\s*WHERE consumed_at IS NULL/);
  });
});

describe("the verifier compare has exactly one implementation", () => {
  // Not an invariant from RECOVERY.md, but it guards the primitive every one of them rests on. This
  // existed SIX times across functions/, spelled four ways, when W73 went to add a seventh. All six
  // were correct — which is the point: a constant-time compare that returns early on the first
  // differing byte passes every functional test in this repo and leaks the verifier by timing. Six
  // chances to write that, in files nobody reads side by side.
  it("is defined only in _lib/verifier.ts", () => {
    const definers = functionFiles
      .filter((f) => /\bfunction (timingSafeEqualStr|sha256Base64Url)\b/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(definers).toEqual(["functions/_lib/verifier.ts"]);
  });

  it("is actually used by the routes that check a stored verifier", () => {
    // The other direction: if the consolidation were reverted by inlining rather than redefining, the
    // check above would still pass while the routes quietly stopped sharing anything.
    const importers = functionFiles
      .filter((f) => /from\s+["'][^"']*\/verifier["']/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(importers.length).toBeGreaterThanOrEqual(6);
  });
});

describe("invariants that cannot be checked statically", () => {
  it("names them, so 'documented' and 'enforced' do not quietly diverge", () => {
    // Listing them here is the honest bookkeeping: each gains a behavioural test in the phase named,
    // and until then RECOVERY.md is describing an intention rather than a guarantee.
    const pending = {
      I3: "every path ends in something the user controls — Phase D route tests",
      I5: "enforced for rung 1 by recovery-set-password.test.ts; rung 2 in Phase D",
      I6: "a recovery method exists before there is data to lose — DEVIATION, minting stays on-demand",
    };
    expect(Object.keys(pending)).toEqual(["I3", "I5", "I6"]);
  });
});
