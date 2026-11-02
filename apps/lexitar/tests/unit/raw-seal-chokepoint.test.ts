// Nothing may write a readable patient original, or a readable transcription of one, into the vault
// bucket — and this file is what makes that structural rather than a habit.
//
// It exists because the 2026-11-02 sealing audit found the opposite: `document-extract.ts` wrote a
// document's whole transcription in cleartext whenever the browser sent no content key, and the
// browser omitted the key precisely for the pre-refusal originals, so every re-open of a legacy
// document minted a fresh readable copy of its own clinical text. The write compiled, type-checked,
// lint-passed and was covered by a green test that asserted it. Nothing in the tree said no.
//
// There is nothing to say no WITH: `env.VAULT` is a plain R2 binding that ten route modules declare
// for themselves, the bytes are a `Uint8Array` with no branded type, and `.oxlintrc.json` carries no
// restriction that could reach a method call. So the enforcement is a static sweep derived from the
// tree — the shape org-key-chokepoint.test.ts and audit-chokepoint.test.ts already use, chosen for
// the same reason: a new file cannot dodge it by being new.
//
// The sweep is deliberately WIDER than the raw family. It names every module that writes an object
// into a bucket at all, because a test that swept only the files already known to write `raw/` would
// be satisfied by the next writer being somewhere else. The cost is that adding any R2 writer fails
// this test until its author classifies it here, which is the price of the guarantee and not a
// defect in it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

// Comments are BLANKED rather than deleted, so surviving offsets still compare and a sweep cannot be
// satisfied by a commented-out guard. org-key-chokepoint.test.ts records how that was learned: the
// first version of a test like this stayed green on a control run with the real call commented out.
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

const files = [...tsFiles(resolve(APP, "functions")), ...tsFiles(resolve(APP, "scripts")), ...tsFiles(resolve(APP, "src"))];
const sourceOf = (rel: string): string => code(readFileSync(resolve(APP, rel), "utf8"));
const rel = (f: string): string => relative(APP, f);

// An object WRITE, in each of the three forms this tree has one: a bucket binding's own `put` (the
// Workers side, where the binding may be named anything — `env.VAULT`, `blobStore`, `deps.vault`),
// `putObject` (the REST helper every script shares), and the `wrangler r2 object put` argument
// vector `pushRaw` shells out to.
const WRITES = /\.put\(|\bputObject\(|"object", "put"/;

const writers = files
  .filter((f) => WRITES.test(code(readFileSync(f, "utf8"))))
  .map(rel)
  .sort();

describe("every module that writes an object into a bucket is named here", () => {
  it("finds the three trees at all, so an empty sweep cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("is this list and no other", () => {
    expect(writers).toEqual([
      // ── the raw family: a patient's own uploaded originals and their transcriptions ──
      // Writes `text/{id}/{file}.json`, the full transcription of a clinical document. Refuses an
      // unsealed original before the model call and then seals the sidecar unconditionally.
      "functions/api/document-extract.ts",
      // Writes `raw/{id}/{file}`, the upload itself. Refuses a body that is not an envelope.
      "functions/api/raw/[[path]].ts",
      // Seals the pre-refusal residue in place. It is the one writer whose whole purpose is to turn a
      // plaintext original into a sealed one, so it writes `await sealRaw(...)` by construction.
      "scripts/raw-encrypt-backfill.ts",
      // Moves every namespace of one client to a new id. Byte-for-byte, so it refuses to carry an
      // unsealed `raw/` or `text/` body onto a new key rather than minting a second readable copy.
      "scripts/commands/rekey.ts",
      // Owns the bucket (`putObject`) and `pushRaw`, the one disk-to-`raw/` path. `pushRaw` reads the
      // file's first 32 bytes and refuses an unsealed one.
      "scripts/vault-sync.ts",

      // ── the vault blob: HD1 version 2, ciphertext under a DEK the deployment cannot open ──
      "functions/_lib/google.ts",
      "functions/api/auth/passkey/register/verify.ts",
      "functions/api/auth/password/signup.ts",
      "functions/api/vault/[id].ts",
      "scripts/commands/rekey-vault.ts",
      "scripts/vault-ops.ts",
      "scripts/vault-rekey.ts",

      // ── ciphertext under a DEK, in namespaces of their own ──
      // chat history and the append-only regen log, both sealed by the browser before they arrive.
      "functions/api/chat-history/[id].ts",
      "functions/api/regen-log/[id].ts",

      // ── neither: these write no PHI into the live bucket ──
      // The request-audit trail, which logs request shape and never content (functions/_lib/log.ts).
      "functions/_lib/audit.ts",
      // Writes to the BACKUP bucket only, and copies what the live bucket holds without reading it.
      "scripts/vault-snapshot.ts",
      // A restore DRILL. It writes a snapshot body back, which for a pre-seal snapshot is plaintext by
      // definition — so it is the one deliberate exception, and its control is that it cannot write
      // outside a scratch prefix (asserted below) and cleans up after itself.
      "scripts/vault-restore.ts",
    ].sort());
  });
});

describe("every writer that can reach a raw-family key refuses cleartext", () => {
  // Named one by one rather than pattern-matched, so a file that stops refusing fails here even if it
  // keeps the word in a comment — the blanking above is what makes the needle mean a call.
  it.each([
    ["functions/api/raw/[[path]].ts", "isSealed(bytes)"],
    ["functions/api/document-extract.ts", "isSealed(stored)"],
    ["scripts/vault-sync.ts", "isSealed(head"],
    ["scripts/commands/rekey.ts", "isSealed(body)"],
  ])("%s holds its own refusal", (file, needle) => {
    expect(sourceOf(file)).toContain(needle);
  });

  // The writer the audit found. A ternary stood here — `rawKey ? await sealRaw(sidecar, rawKey) :
  // sidecar` — and the refusals above the write are what make it unnecessary rather than merely
  // unused, so the assertion is that the cleartext arm is gone and not merely unreachable.
  it("seals the transcription with no cleartext arm left to fall back to", () => {
    const src = sourceOf("functions/api/document-extract.ts");
    expect(src).toContain("await env.VAULT.put(sidecarKey, await sealRaw(sidecar, rawKey));");
    expect(src).not.toMatch(/VAULT\.put\([^)]*:\s*sidecar/);
  });

  // The backfill is the exception that proves the rule: it is handed plaintext deliberately, and what
  // it writes is the seal of it.
  it("the sealing sweep writes only through sealRaw", () => {
    const src = sourceOf("scripts/raw-encrypt-backfill.ts");
    expect(src).toContain("await sealRaw(plain, minted[file])");
    expect(src.match(/putObject\(LIVE_BUCKET, r2Key/g)).toHaveLength(1);
  });

  // The restore drill's control, since it is the one writer allowed to put plaintext into the live
  // bucket: every key it writes is routed through the scratch rewrite, so a drill cannot land on a
  // real patient's key even if its snapshot holds one.
  it("the restore drill can only write under its scratch prefix", () => {
    expect(sourceOf("scripts/vault-restore.ts")).toContain("putObject(LIVE_BUCKET, liveKeyToScratch(o.key)");
  });
});
