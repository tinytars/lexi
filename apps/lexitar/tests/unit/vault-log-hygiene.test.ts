// The snapshot and sync scripts run in GitHub Actions on a PUBLIC repository, so everything they
// write to stdout or stderr — and every message they throw, which the top-level handler writes to
// stderr — is readable by anyone, forever. An R2 key is not safe to write there: `{store}/raw/
// <account>/<filename>` carries both the account id and the name of a file a person uploaded.
//
// This suite pins the redaction rather than the formatting. The last test is the one that matters:
// the first three could all pass while a new diagnostic added next month prints a key, so it asks
// the source itself, line by line, instead of asking the three helpers that happen to exist today.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keyRef, redactedBody } from "../../scripts/vault-sync";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(resolve(here, "../../scripts", name), "utf8");

// The shape the redaction exists for: an uploaded file under an account's own prefix.
const ACCOUNT = "9f3c1aa7e4b2";
const FILENAME = "blood-panel-2026-03.pdf";
const RAW_KEY = `prod/raw/${ACCOUNT}/${FILENAME}`;

describe("keyRef — a key's class and a digest, never the key", () => {
  it("names the store region and discloses neither the filename nor the account id", () => {
    const ref = keyRef(RAW_KEY);

    expect(ref).toMatch(/^raw \(sha256:[0-9a-f]{12}\)$/);
    expect(ref).not.toContain(FILENAME);
    expect(ref).not.toContain(ACCOUNT);
    expect(ref).not.toContain("prod");
  });

  it("is stable across runs, so the same object correlates between two snapshots", () => {
    expect(keyRef(RAW_KEY)).toBe(keyRef(RAW_KEY));
  });

  it("distinguishes two objects in the same class, which is what makes a digest worth printing", () => {
    expect(keyRef(RAW_KEY)).not.toBe(keyRef(`prod/raw/${ACCOUNT}/other.pdf`));
  });

  it("says `unclassified` rather than throwing on a key shape it has not been taught", () => {
    // classifyKey returns null for an unknown shape and the snapshot treats that as a hard error —
    // but the error message itself still has to be printable, which is this case.
    expect(keyRef("prod/something-new/x")).toMatch(/^unclassified \(sha256:[0-9a-f]{12}\)$/);
    expect(keyRef("no-slash-at-all")).toMatch(/^unclassified \(sha256:[0-9a-f]{12}\)$/);
  });
});

describe("redactedBody — an S3 error document may echo the key back", () => {
  it("replaces the key it was asked about and keeps the rest of the body", () => {
    // AWS's NoSuchKey carries a <Key> element and R2 aims for S3 compatibility, so a body is
    // scrubbed rather than trusted. The status alone does not say whether a 400 was a malformed
    // range or a quota, which is why the body is printed at all.
    const body = `<Error><Code>NoSuchKey</Code><Key>${RAW_KEY}</Key></Error>`;
    const out = redactedBody(body, RAW_KEY);

    expect(out).not.toContain(FILENAME);
    expect(out).not.toContain(ACCOUNT);
    expect(out).toContain("NoSuchKey");
    expect(out).toContain(keyRef(RAW_KEY));
  });

  it("replaces every occurrence, not the first", () => {
    const out = redactedBody(`${RAW_KEY} and again ${RAW_KEY}`, RAW_KEY);
    expect(out).not.toContain(FILENAME);
  });
});

describe("no key is formatted into a string without being redacted", () => {
  // This asks the whole file rather than the lines that write or throw, and the difference is not
  // cosmetic: the first version of this test scoped itself to an emitting statement, and a negative
  // control proved it walked straight past the unrecognised-shape refusal, which built its message
  // into a `detail` variable one statement earlier and printed ten raw keys. Anything that puts a
  // key INTO a string is a candidate for reaching the log, wherever it sits.
  //
  // It matches a property access ending in key/…Key, never the word "key": these scripts' messages
  // are prose about keys and a prose match would say nothing. Measured against both files, that
  // reports the nine diagnostic sites and none of the key-BUILDING code, which is what makes a
  // whole-file check usable here — every key in vault-sync.ts is assembled from its parts or
  // passed as an argument, so none of it is caught.
  const KEY_ACCESS = /\.\s*(key|[A-Za-z]*Key)\b/;
  const INTO_A_STRING = [/\$\{([^}]*)\}/g, /\.map\(([^;]{0,120}?)\)\s*\.join\(/g];

  // The two exceptions, named here rather than left to the reader. `manifest.logBundleKey` is a
  // snapshot artifact path carrying a snapshot id, not a user object, and which bundle is missing
  // is the whole point of the line printing it. A `log-hygiene-ok:` comment marks a site that
  // prints a raw key on purpose and says why on the same line — there is one, and it is the half
  // of the unrecognised-shape refusal that runs outside CI, where the log is the operator's own.
  const EXEMPT = /manifest\.logBundleKey/g;

  for (const file of ["vault-sync.ts", "vault-snapshot.ts"]) {
    it(`holds for ${file}`, () => {
      const text = source(file);
      const offenders: string[] = [];

      for (const pattern of INTO_A_STRING) {
        for (const m of text.matchAll(pattern)) {
          const line = text.slice(0, m.index!).split("\n").length;
          if (/log-hygiene-ok:/.test(text.split("\n")[line - 1] ?? "")) continue;
          const expr = m[1]
            // A key reached only to hand to one of the two redaction helpers is the point of them,
            // so what they enclose is removed before the check rather than excused after it.
            .replace(/keyRef\([^)]*\)/g, "")
            .replace(/redactedBody\([^)]*\)/g, "")
            .replace(EXEMPT, "");
          if (KEY_ACCESS.test(expr)) offenders.push(`${file}:${line}  ${m[0]}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  }
});
