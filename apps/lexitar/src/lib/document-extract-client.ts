// The browser side of document extraction: decide whether an attachment is readable at all, ask
// /api/document-extract to read it (once, ever — the endpoint caches by content key), and collect
// already-extracted text for the surfaces that fold documents into a turn.
//
// Failures here are never fatal to the thing the user actually asked for. A document that cannot be
// read degrades the turn to text-and-images, exactly as an unfetchable photo already does in
// leaf-regen-client.ts — the assessment is the deliverable; the document is an enhancement.
import type { Attachment } from "./types";
import { AiError, withDeadline } from "./ai-error";
import { capDocuments, type DocumentText, type StoredExtraction } from "@pablotech/akesi/document-read";
import type { PageImage } from "@pablotech/akesi/report-extract";
import { normalizeClientId } from "./client-id";
import { reportsAreAttached } from "./corpus-warm-client";
import { rawKeyFor } from "./vault-raw-keys";
import { openRaw } from "./raw-cipher";

// A model call on a long PDF is slower than a leaf regen's own scoped call but bounded the same
// way — past this the attach reports a reason instead of spinning (leaf-regen-config.ts's comment
// applies verbatim).
export const DOCUMENT_EXTRACT_DEADLINE_MS = 180_000;

export function isPdfAttachment(a: Pick<Attachment, "name" | "mediaType">): boolean {
  return a.mediaType === "application/pdf" || /\.pdf$/i.test(a.name);
}

/**
 * The attachments still worth transcribing. Where the deployment attaches reports, a PDF is already
 * in the request as its own bytes and its transcription would be the same document a second time;
 * where it is off, that transcription is the only copy the model gets (CORPUS.md).
 */
export function needTranscription<T extends Pick<Attachment, "name" | "mediaType">>(attachments: T[]): T[] {
  return reportsAreAttached() ? attachments.filter((a) => !isPdfAttachment(a)) : attachments;
}

/** Readable as prose. Spreadsheets are deliberately absent — they route to the marker importer. */
export function isExtractableDocument(a: Pick<Attachment, "name" | "mediaType">): boolean {
  return isPdfAttachment(a) || a.mediaType.startsWith("text/") || /\.(txt|md|markdown)$/i.test(a.name);
}

/**
 * Reads one attachment, storing the text server-side. Returns the reading; throws an AiError.
 *
 * `pageImages` rides along only for a model that can see but cannot take a PDF: the relay has the
 * bytes in R2 already and normally needs nothing but the key, but it has no pdfjs to render them.
 */
export async function extractDocument(clientId: string, a: Attachment, pageImages?: PageImage[]): Promise<StoredExtraction> {
  const rawKey = rawKeyFor(clientId, a.key);
  const res = await withDeadline(DOCUMENT_EXTRACT_DEADLINE_MS, (signal) =>
    fetch("/api/document-extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The key the relay needs to open the stored document, and to seal the transcription it
      // writes back beside it. Absent for a document stored before the sweep, which still reads.
      body: JSON.stringify({
        id: normalizeClientId(clientId),
        key: a.key,
        mediaType: a.mediaType,
        ...(rawKey ? { rawKey } : {}),
        ...(pageImages ? { pageImages } : {}),
      }),
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
  // The sidecar is sealed under the SAME content key as the document it transcribes, and the route
  // hands back whichever format it holds — so the bytes are read raw and opened, not res.json()'d.
  const parsed = await openSidecar(await res.arrayBuffer(), clientId, key);
  if (parsed) sidecarCache.set(cacheKey, parsed);
  return parsed;
}

/** The sidecar's JSON, decrypting first where the store already holds it sealed. */
async function openSidecar(body: ArrayBuffer, clientId: string, key: string): Promise<StoredExtraction | null> {
  try {
    const plain = await openRaw(new Uint8Array(body), `${key}.json`, rawKeyFor(clientId, key));
    return JSON.parse(new TextDecoder().decode(plain)) as StoredExtraction;
  } catch {
    return null;
  }
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
