// W77 — record the page count of every raw PDF stored before counts were kept.
//
// WHY IT MATTERS. The report corpus refuses to assemble while any PDF in a namespace is unmeasured,
// because a guessed count would silently send an over-limit request (CORPUS.md). Every object written
// before migration 0015 has no count, so without a backfill every existing patient's inferences
// refuse with `corpus_unmeasured` until they happen to open the app and the browser heals it
// (src/lib/raw-pages-heal.ts). This is the operator's sweep for the rest.
//
//   npm run raw:pages                                     # report only
//   npm run raw:pages -- --confirm                        # write the counts
//   npm run raw:pages -- --purge-unreadable --confirm     # also delete the files nothing can open
//
// Like every script here it targets THIS WORKTREE's environment (scripts/target.ts), so it runs once
// per environment: from a `dev` checkout for health-identity-dev, from a `main` one for prod.
//
// It needs ORG_KEY_PASSPHRASE only once it meets a SEALED object: pdf.js counts pages of a PDF, not
// of an envelope, so a sealed file is opened through scripts/raw-cipher-cli.ts first. A store still
// holding plaintext is measured without the org key ever being loaded. Keys with no `raw_objects`
// row are not its business — that is ownership, and scripts/raw-backfill.ts owns it.
//
// --purge-unreadable is IRREVERSIBLE outside the vault-sync backup window, so it is an owner
// decision made per environment, never a default: a file nothing can open holds no information, but
// it is still the patient's upload. What makes it worth offering is that one such file freezes the
// corpus for that patient's whole namespace, and there is no other way out of `corpus_unmeasured`.

import "./load-creds";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, deleteObject, getObject, resolveStore } from "./vault-sync";
import { openStored } from "./raw-cipher-cli";
import { flushOrgKeyUses } from "./access-log";
import { RawKeyError } from "../src/lib/raw-cipher";
import { isMain } from "./is-main";

const STORE = resolveStore();
const CHUNK = 50;

/**
 * pdfjs-dist directly, not @tinytars/frame's openPdf, which sets a browser bundler's `workerSrc` at
 * import and throws outside one. In Node the legacy build runs its own fake worker.
 */
async function countPages(bytes: Uint8Array): Promise<number | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    // The cast is what @tinytars/frame's openPdf does: pdfjs-dist's types lag `isEvalSupported`,
    // which is worth keeping on bytes of unknown origin being read on an operator's machine.
    const params = { data: bytes, isEvalSupported: false } as unknown as Parameters<typeof pdfjs.getDocument>[0];
    return (await pdfjs.getDocument(params).promise).numPages;
  } catch {
    return null;
  }
}

/** One statement per chunk: CASE so a chunk is one round trip, `pages IS NULL` so it can only fill. */
export function fillStatement(rows: Array<{ key: string; pages: number; bytes: number }>): string {
  const pages = rows.map((r) => `WHEN ${q(r.key)} THEN ${r.pages}`).join(" ");
  const sizes = rows.map((r) => `WHEN ${q(r.key)} THEN ${r.bytes}`).join(" ");
  const keys = rows.map((r) => q(r.key)).join(", ");
  return (
    `UPDATE raw_objects SET pages = CASE r2_key ${pages} END, bytes = CASE r2_key ${sizes} END ` +
    `WHERE r2_key IN (${keys}) AND pages IS NULL`
  );
}

/**
 * The transcription sidecar document-extract.ts caches beside a raw file (`text/{id}/{key}.json`).
 * Purging the PDF without it would leave a transcription of a document that no longer exists.
 */
export function sidecarKeyOf(rawKey: string): string {
  return `${rawKey.replace("/raw/", "/text/")}.json`;
}

/** Every key a purge removes, raw and sidecar, in the order it removes them. */
export function purgedKeys(unreadable: string[]): string[] {
  return unreadable.flatMap((k) => [k, sidecarKeyOf(k)]);
}

async function purge(unreadable: string[]): Promise<void> {
  const keys = purgedKeys(unreadable);
  for (const key of keys) await deleteObject(LIVE_BUCKET, key);
  for (let i = 0; i < keys.length; i += CHUNK) {
    await d1(`DELETE FROM raw_objects WHERE r2_key IN (${keys.slice(i, i + CHUNK).map(q).join(", ")})`);
  }
  process.stdout.write(`Purged ${unreadable.length} unreadable file(s) and their sidecars.\n`);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const purgeUnreadable = process.argv.includes("--purge-unreadable");

  const unmeasured = await d1<{ r2_key: string }>(
    `SELECT r2_key FROM raw_objects WHERE pages IS NULL AND lower(r2_key) LIKE '%.pdf' AND r2_key LIKE ${q(`${STORE}/raw/%`)} ORDER BY r2_key`,
  );
  process.stdout.write(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")\n`);
  process.stdout.write(`Unmeasured PDFs: ${unmeasured.length}\n\n`);
  if (unmeasured.length === 0) return;

  const measured: Array<{ key: string; pages: number; bytes: number }> = [];
  const unreadable: string[] = [];
  // SEALED AND UNOPENABLE IS NOT UNREADABLE, and keeping the two apart is what stops --purge-unreadable
  // from deleting a perfectly good file whose owner revoked org recovery. Only the browser can open
  // those, so this run reports them and leaves them exactly where they are.
  const unreachable: string[] = [];
  for (const { r2_key } of unmeasured) {
    const stored = await getObject(LIVE_BUCKET, r2_key);
    if (!stored) {
      unreadable.push(r2_key);
      continue;
    }
    let plain: Uint8Array;
    try {
      plain = await openStored(r2_key, stored, STORE);
    } catch (e) {
      if (!(e instanceof RawKeyError)) throw e;
      unreachable.push(r2_key);
      continue;
    }
    const pages = await countPages(plain);
    // `bytes` records what STORAGE holds, matching what the PUT route records for a new upload — the
    // envelope's 48 bytes are storage, and the corpus budgets against this column.
    if (!pages) unreadable.push(r2_key);
    else measured.push({ key: r2_key, pages, bytes: stored.length });
  }

  process.stdout.write(`Measured: ${measured.length}   unreadable: ${unreadable.length}   unreachable: ${unreachable.length}\n`);
  // Named loudly: a PDF nothing can open stays unmeasured, and the corpus keeps refusing for that
  // whole namespace. Deleting it or replacing it is an owner decision, which --purge-unreadable is.
  for (const key of unreadable) process.stdout.write(`  ! ${key}: not a readable PDF\n`);
  for (const key of unreachable) process.stdout.write(`  ~ ${key}: sealed, and no key here opens it — the owner's browser heals this\n`);

  if (!confirm) {
    const also = purgeUnreadable ? ` and purge ${unreadable.length} unreadable file(s)` : "";
    process.stdout.write(`\nReport only. Re-run with --confirm to write ${measured.length} page count(s)${also}.\n`);
    return;
  }

  for (let i = 0; i < measured.length; i += CHUNK) {
    await d1(fillStatement(measured.slice(i, i + CHUNK)));
    process.stdout.write(`  wrote ${Math.min(i + CHUNK, measured.length)}/${measured.length}\n`);
  }
  if (purgeUnreadable && unreadable.length) await purge(unreadable);
  process.stdout.write(`\nDone.\n`);
}

if (isMain(import.meta.url)) {
  // The flush runs on both exits: an org-key decrypt that happened must be logged even when the run
  // then fails (scripts/access-log.ts).
  main()
    .then(() => flushOrgKeyUses())
    .catch(async (e) => {
      await flushOrgKeyUses().catch(() => undefined);
      process.stderr.write(`\n${(e as Error).message}\n`);
      process.exit(1);
    });
}
