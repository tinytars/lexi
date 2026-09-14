// The browser side of document extraction: decide whether an attachment is readable at all, ask
// /api/document-extract to read it (once, ever — the endpoint caches by content key), and collect
// already-extracted text for the surfaces that fold documents into a turn.
//
// Failures here are never fatal to the thing the user actually asked for. A document that cannot be
// read degrades the turn to text-and-images, exactly as an unfetchable photo already does in
// leaf-regen-client.ts — the assessment is the deliverable; the document is an enhancement.
import type { Attachment } from "./types";
import { AiError, withDeadline } from "./ai-error";
import { capDocuments, type DocumentText, type StoredExtraction } from "@pablotech/akesi-pil/document-read";
import { normalizeClientId } from "./client-id";

// A model call on a long PDF is slower than a leaf regen's own scoped call but bounded the same
// way — past this the attach reports a reason instead of spinning (leaf-regen-config.ts's comment
// applies verbatim).
export const DOCUMENT_EXTRACT_DEADLINE_MS = 180_000;

export function isPdfAttachment(a: Pick<Attachment, "name" | "mediaType">): boolean {
  return a.mediaType === "application/pdf" || /\.pdf$/i.test(a.name);
}

/** Readable as prose. Spreadsheets are deliberately absent — they route to the marker importer. */
export function isExtractableDocument(a: Pick<Attachment, "name" | "mediaType">): boolean {
  return isPdfAttachment(a) || a.mediaType.startsWith("text/") || /\.(txt|md|markdown)$/i.test(a.name);
}

/** Reads one attachment, storing the text server-side. Returns the reading; throws an AiError. */
export async function extractDocument(clientId: string, a: Attachment): Promise<StoredExtraction> {
  const res = await withDeadline(DOCUMENT_EXTRACT_DEADLINE_MS, (signal) =>
    fetch("/api/document-extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: normalizeClientId(clientId), key: a.key, mediaType: a.mediaType }),
      signal,
    }).catch((e) => {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("could not reach the server to read this document", { errorCode: "offline" });
    }),
  );
  const body = (await res.json().catch(() => null)) as (StoredExtraction & { error?: string; errorCode?: string }) | null;
  if (!res.ok) {
    throw new AiError(body?.error || `reading the document failed (${res.status})`, {
      errorCode: body?.errorCode,
      status: res.status,
    });
  }
  return body as StoredExtraction;
}

/** The metadata stamped onto the Attachment after a read — text stays in the sidecar. */
export function extractedMetadata(reading: StoredExtraction): NonNullable<Attachment["extracted"]> {
  return { at: reading.at, chars: reading.chars, ...(reading.documentKind ? { kind: reading.documentKind } : {}) };
}

// Attachment keys are content-addressed, so a key's text can never change — an in-memory cache is
// safe for the life of the page, and is what keeps a chat send from re-fetching every prior turn's
// documents on every round (the same re-send tax the image path pays and cannot avoid).
const sidecarCache = new Map<string, StoredExtraction | null>();

/** The sidecar only. Returns null when this attachment has never been extracted — never extracts. */
export async function fetchExtractedText(clientId: string, key: string): Promise<StoredExtraction | null> {
  const cacheKey = `${normalizeClientId(clientId)}/${key}`;
  const hit = sidecarCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const res = await fetch(`/api/document-extract?id=${encodeURIComponent(normalizeClientId(clientId))}&key=${encodeURIComponent(key)}`);
  // A miss is NOT cached: extraction may still be in flight, or may be retried, and caching the
  // absence would make the document permanently invisible for this page load.
  if (!res.ok) return null;
  const parsed = (await res.json().catch(() => null)) as StoredExtraction | null;
  if (parsed) sidecarCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * The extracted text of every readable document in `attachments`, ready to be injected into a
 * prompt. Silently drops anything not yet extracted or no longer fetchable, and truncates rather
 * than letting one enormous document push a request past the relay's body cap — always saying so
 * in the text itself, so the model never treats a cut-off document as complete.
 */
export async function documentTextsFor(clientId: string, attachments: Attachment[]): Promise<DocumentText[]> {
  const docs = attachments.filter(isExtractableDocument);
  if (docs.length === 0) return [];
  const settled = await Promise.allSettled(docs.map((a) => fetchExtractedText(clientId, a.key).then((r) => ({ a, r }))));

  const found: DocumentText[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value.r?.text) continue;
    found.push({ name: s.value.a.name, text: s.value.r.text });
  }
  return capDocuments(found);
}
