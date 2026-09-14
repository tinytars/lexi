import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyKey } from "../../scripts/vault-sync";

// W69 — the backup tool must know every key class the app writes.
//
// vault-snapshot.ts refuses to run when it meets a key whose shape classifyKey() does not recognise,
// which is the right call: a silent skip would mean a backup that quietly omits a whole class. But the
// refusal lands at 3:15am in a launchd log nobody reads. W46's document-extract sidecar
// ({store}/text/{id}/{file}.json, document-extract.ts:98) added a class classifyKey() never learned,
// and the first object of that shape appeared on 2026-08-19 — so from 2026-08-20 the nightly snapshot
// failed five nights running while the app kept serving. The only thing that noticed was a CI gate
// that happened to check backup freshness, on an unrelated promotion PR.
//
// classifyKey's own unit test could not catch it: it enumerates the classes BY HAND, so it agrees with
// classifyKey by construction and would keep passing forever. This derives the expectation from the
// other side — storeKey()'s actual call sites in functions/ — so adding a new prefix fails here, in
// the suite, at the commit that adds it.
//
// Static source walk (same shape as cli-import-graph.test.ts): no bundler, no runtime import.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `storeKey(env, "raw", …)` — a literal second argument is a DIRECTORY prefix under the store. */
const PREFIX_CALL = /\bstoreKey\(\s*[^,()]+,\s*"([a-z][a-z0-9-]*)"/g;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFilesUnder(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

const prefixes = new Map<string, string>(); // prefix -> where it is written
for (const file of tsFilesUnder(resolve(ROOT, "functions"))) {
  for (const m of readFileSync(file, "utf8").matchAll(PREFIX_CALL)) {
    if (!prefixes.has(m[1])) prefixes.set(m[1], file.slice(ROOT.length + 1));
  }
}

describe("every key class the app writes is one the backup can classify", () => {
  it("finds the storeKey call sites at all, so an empty sweep cannot pass silently", () => {
    expect([...prefixes.keys()].sort()).toEqual(expect.arrayContaining(["logs", "raw", "text"]));
  });

  it.each([...prefixes].map(([p, where]) => [p, where]))("%s (written by %s)", (prefix) => {
    // The shape is {store}/{prefix}/…; the trailing segments vary by class and classifyKey
    // deliberately does not care about them.
    expect(classifyKey("dev", `dev/${prefix}/some-id/some-file.json`)).not.toBeNull();
  });

  // W72 — the incident this file was written for happened AGAIN, and this file did not catch it.
  //
  // The nightly snapshot refused to run on five consecutive nights (2026-08-20 to 2026-08-24) on a
  // `dev/text/{id}/{sha8}-{name}.pdf.json` key. `text` was already in the sweep
  // above and the test was green the whole time: the sweep proves classifyKey knows the PREFIX, and
  // the failure was that it did not know the prefix at all — the fix landed in 0d0f29f, a day after
  // the sweep would have started reporting `text` as a written prefix.
  //
  // So the sweep answers "is this prefix classified" and the real keys answer "is THIS key
  // classified", and only the second is what the snapshot actually asks. These are real key shapes
  // with the patient-identifying segments replaced — the double extension and the content-hash prefix
  // are the parts that matter, and neither appears in `some-file.json`.
  it.each([
    ["dev/text/patient/4d39693e-a_document_name.pdf.json", "text"],
    ["dev/raw/patient/2025November17-imaging-37fe2b1b.pdf", "raw"],
    ["dev/data-8dafade9-9f33-426d-bb35-1f63ae168212.enc", "vault"],
    ["dev/chat-patient.enc", "chat"],
    ["dev/logs/refresh-finding/2026-07-15/a1b92036-1.json", "logs"],
  ])("classifies %s, a real-shaped key, as %s", (key, expected) => {
    expect(classifyKey("dev", key as string)).toBe(expected);
  });
});
