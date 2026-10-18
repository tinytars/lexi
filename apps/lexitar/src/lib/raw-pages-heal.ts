// W77 — fill in the page counts of PDFs stored before counts were kept.
//
// The report corpus refuses to assemble while any PDF in a client's namespace is unmeasured, since a
// guessed count would silently send an over-limit request (CORPUS.md). Every object already in R2 is
// unmeasured, and only a browser can fix that: pdf.js does not run on Workers. So the server names
// what it is missing, this re-opens each PDF to count it, and posts the counts back — no bytes are
// re-uploaded, and the server refuses to CHANGE a count that is already recorded, so a second tab
// doing the same work costs bandwidth and nothing else.
import { normalizeClientId } from "./client-id";
import { countPdfPages, fetchAttachmentBytes } from "./attachment-store";

/** Matches MAX_COUNTS in functions/api/raw/measure.ts. */
const BATCH = 200;

interface Count {
  file: string;
  pages: number;
}

async function measure(clientId: string, file: string): Promise<Count | null> {
  // The PLAINTEXT bytes: pdf.js counts pages of a PDF, not of an envelope. A file this vault holds
  // no key for stays unmeasured, exactly like one pdf.js cannot open — see below.
  const bytes = await fetchAttachmentBytes(clientId, file).catch(() => null);
  if (!bytes) return null;
  const pages = await countPdfPages(bytes, file, "application/pdf");
  // A PDF pdf.js cannot open stays unmeasured, and the corpus keeps refusing rather than guessing.
  // That is the intended end state for a file nothing in the app can read: scripts/raw-pages-backfill.ts
  // is the operator's second attempt, not a silent default.
  return pages === undefined ? null : { file, pages };
}

/**
 * Measures every unmeasured PDF under one client, returning how many counts were recorded.
 *
 * Best effort by design — it runs unawaited behind whatever the user is actually doing, so a failure
 * anywhere leaves the corpus refusing loudly at inference time, which is the behaviour it would have
 * had anyway.
 */
export async function healRawPageCounts(clientId: string): Promise<number> {
  const id = normalizeClientId(clientId);
  const listed = await fetch(`/api/raw/${id}?unmeasured=1`).catch(() => null);
  if (!listed?.ok) return 0;
  const { files } = (await listed.json()) as { files: string[] };

  let measured = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const counts = (await Promise.all(files.slice(i, i + BATCH).map((f) => measure(id, f).catch(() => null)))).filter(
      (c): c is Count => c !== null,
    );
    if (counts.length === 0) continue;
    const res = await fetch("/api/raw/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: id, counts }),
    });
    if (res.ok) measured += ((await res.json()) as { measured: number }).measured;
  }
  return measured;
}
