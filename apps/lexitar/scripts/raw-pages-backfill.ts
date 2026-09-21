// W77 — record the page count of every raw PDF stored before counts were kept.
//
// WHY IT MATTERS. The report corpus refuses to assemble while any PDF in a namespace is unmeasured,
// because a guessed count would silently send an over-limit request (CORPUS.md). Every object written
// before migration 0015 has no count, so without a backfill every existing patient's inferences
// refuse with `corpus_unmeasured` until they happen to open the app and the browser heals it
// (src/lib/raw-pages-heal.ts). This is the operator's sweep for the rest.
//
//   npm run raw:pages              # report only
//   npm run raw:pages -- --confirm # write the counts
//
// Like every script here it targets THIS WORKTREE's environment (scripts/target.ts), so it runs once
// per environment: from a `dev` checkout for health-identity-dev, from a `main` one for prod.
//
// It needs no org key and decrypts nothing: a page count keys off `r2_key` alone. Keys with no
// `raw_objects` row are not its business — that is ownership, and scripts/raw-backfill.ts owns it.

import "./load-creds";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, getObject, resolveStore } from "./vault-sync";
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

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  const unmeasured = await d1<{ r2_key: string }>(
    `SELECT r2_key FROM raw_objects WHERE pages IS NULL AND lower(r2_key) LIKE '%.pdf' AND r2_key LIKE ${q(`${STORE}/raw/%`)} ORDER BY r2_key`,
  );
  process.stdout.write(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")\n`);
  process.stdout.write(`Unmeasured PDFs: ${unmeasured.length}\n\n`);
  if (unmeasured.length === 0) return;

  const measured: Array<{ key: string; pages: number; bytes: number }> = [];
  const unreadable: string[] = [];
  for (const { r2_key } of unmeasured) {
    const bytes = await getObject(LIVE_BUCKET, r2_key);
    const pages = bytes && (await countPages(bytes));
    if (!bytes || !pages) unreadable.push(r2_key);
    else measured.push({ key: r2_key, pages, bytes: bytes.length });
  }

  process.stdout.write(`Measured: ${measured.length}   unreadable: ${unreadable.length}\n`);
  // Named loudly: a PDF nothing can open stays unmeasured, and the corpus keeps refusing for that
  // whole namespace. Deleting it or replacing it is an owner decision, not this script's.
  for (const key of unreadable) process.stdout.write(`  ! ${key}: not a readable PDF\n`);

  if (!confirm) {
    process.stdout.write(`\nReport only. Re-run with --confirm to write ${measured.length} page count(s).\n`);
    return;
  }

  for (let i = 0; i < measured.length; i += CHUNK) {
    await d1(fillStatement(measured.slice(i, i + CHUNK)));
    process.stdout.write(`  wrote ${Math.min(i + CHUNK, measured.length)}/${measured.length}\n`);
  }
  process.stdout.write(`\nDone.\n`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}
