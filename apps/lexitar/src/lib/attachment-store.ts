// W46 Phase 3 — generalizes treatment-image-store.ts (M54/5, treatment-photo-only) into the shared
// browser-side helper for every leaf's Attach flow, wrapping the /api/raw/{id}/{file} PUT/GET/DELETE
// contract (functions/api/raw/[[path]].ts). Keys mirror PendingUpload.file (types.ts):
// "<sha8>-<safeName>" under raw/{id}/. GET goes through attachment-blob.ts, which decrypts and
// mints the blob: URL the UI points <img src>/download links at.
import { hashSourceWeb } from "@pablotech/akesi/ingest-core";
import { compressImage } from "./image-compress";
import { fetchAttachmentBytes } from "./attachment-blob";
import { mintRawKey, rawKeyFor } from "./vault-raw-keys";
import { sealRaw } from "./raw-cipher";
import { bytesToBase64 } from "./base64";
import { openPdf, type PdfDoc } from "@tinytars/frame/pdf-render";
import { MAX_DOCUMENT_PAGES } from "@pablotech/akesi/document-read";
import { extractDocument, extractedMetadata, isExtractableDocument, isPdfAttachment } from "./document-extract-client";
import { normalizeClientId } from "./client-id";
import { ABILITY_UNAVAILABLE, supports } from "./model-ability";
import { needsPageImages, renderOpenPdfPages } from "./pdf-pages-for-model";
import type { Attachment } from "./types";

// W46 Phase 4 — client-side guards that /api/raw itself doesn't enforce (it only caps at 24 MB
// server-side, surfacing as a bare 413 after a full round-trip). MAX_VISION_ATTACHMENTS mirrors
// functions/api/treatment-image-infer.ts's own 4-image cap — the number a leaf that also feeds
// vision inference (Treatment's "Identify from photos") should stay under; MAX_ATTACHMENTS is the
// broader storage-only cap for a single Attach action.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_VISION_ATTACHMENTS = 4;
export const MAX_ATTACHMENTS = 10;

export async function buildAttachmentKey(bytes: Uint8Array, originalName: string): Promise<string> {
  const { sha256 } = await hashSourceWeb(bytes);
  const sha8 = sha256.slice(0, 8);
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${sha8}-${safeName}`;
}

/**
 * How many pages this PDF has, or undefined if it isn't one or pdfjs cannot open it.
 *
 * The browser is the only place this can be measured: pdf.js does not run on Workers, so the
 * Function receiving the upload cannot count for itself, and a count guessed from byte size is
 * worthless (a 12 MB scan can be two pages). The count travels with the upload as `?pages=` and is
 * what the report corpus checks its page ceiling against — see CORPUS.md.
 */
export async function countPdfPages(bytes: Uint8Array, name: string, mediaType?: string): Promise<number | undefined> {
  if (mediaType !== "application/pdf" && !/\.pdf$/i.test(name)) return undefined;
  try {
    // .slice() for the same reason as attachFiles below: pdf.js detaches the buffer it is handed.
    return (await openPdf(bytes.slice())).numPages;
  } catch {
    return undefined;
  }
}

// The one choke point every upload funnels through, which is why the sealing lives here and not at
// each Attach handler: a lane that forgot to seal would put plaintext PHI back in the bucket.
//
// `?pages=N` is counted on the PLAINTEXT above and rides along unchanged — pdf.js cannot count the
// pages of an envelope, and the corpus checks its page ceiling against this number.
export async function putRaw(clientId: string, key: string, bytes: Uint8Array, pages?: number): Promise<Response> {
  const query = pages === undefined ? "" : `?pages=${pages}`;
  // A key already on the ring is REUSED, never replaced: attachment keys are content-addressed, so a
  // re-PUT is the same bytes, and minting a second key would strand the copy already in R2 if the
  // upload then failed. No open vault means no way to record a key at all, so the upload stays
  // plaintext rather than becoming a file nobody can ever open — the self-heal seals it on the next
  // open (vault-raw-keys.ts).
  const contentKey = rawKeyFor(clientId, key) ?? (await mintRawKey(clientId, key));
  const body = contentKey ? await sealRaw(bytes, contentKey) : bytes;
  return fetch(`/api/raw/${normalizeClientId(clientId)}/${key}${query}`, {
    method: "PUT",
    // /api/raw is gated by the hd_session cookie (W44) — same-origin fetch sends it automatically.
    headers: { "Content-Type": "application/octet-stream" },
    body: body as BodyInit,
  });
}

export async function uploadAttachment(clientId: string, bytes: Uint8Array, key: string, pages?: number): Promise<void> {
  const res = await putRaw(clientId, key, bytes, pages);
  if (!res.ok && res.status !== 204) {
    throw new Error(`storing the attachment failed (${res.status})`);
  }
}

// A `blob:` URL, not the API path: stored originals are ciphertext, so an element cannot render
// `/api/raw/...` directly any more. The name and the (clientId, key) shape are unchanged — every
// caller passes this straight to AttachmentStrip/AttachmentViewer, which resolve it.
export { attachmentBlobUrl as attachmentUrl, fetchAttachmentBytes, revokeAttachmentBlobs } from "./attachment-blob";

// W46 Phase 6 — chat vision needs an attachment's bytes back as base64 for an Anthropic `image`
// content block (functions/api/chat.ts). Unlike treatment-image-client.ts's inference relay
// (which base64s bytes already in hand, pre-upload), a chat attachment is uploaded once at Attach
// time and re-fetched here whenever it needs to ride along with a question — including every time
// a PRIOR turn's image is resent as conversation history, since Anthropic has no server-side
// image cache across turns.
export async function fetchAttachmentBase64(clientId: string, key: string): Promise<string> {
  return bytesToBase64(await fetchAttachmentBytes(clientId, key));
}


// Compresses (images) or reads-through (everything else), uploads, and returns the resulting
// Attachment[] — the one path every leaf's "Attach" onFiles handler calls, so the compress→hash→
// PUT→Attachment sequence lives in exactly one place. Caller is responsible for appending the
// result onto the target item's `attachments` and persisting.
export async function attachFiles(
  clientId: string,
  files: File[],
  opts?: { maxCount?: number; extractDocuments?: boolean },
): Promise<Attachment[]> {
  const capped = files.slice(0, opts?.maxCount ?? MAX_ATTACHMENTS);
  const out: Attachment[] = [];
  for (const file of capped) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${file.name}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`);
    }
    let bytes: Uint8Array;
    let mediaType: string;
    if (file.type.startsWith("image/")) {
      try {
        const compressed = await compressImage(file);
        bytes = compressed.bytes;
        mediaType = compressed.mediaType;
      } catch {
        // HEIC gotcha — createImageBitmap decodes it on Safari but not on desktop Chrome; on
        // failure, store the original bytes untouched rather than failing the attach. The stored
        // file just won't get an in-app thumbnail (Phase 5) until a browser that can decode it.
        bytes = new Uint8Array(await file.arrayBuffer());
        mediaType = file.type;
      }
    } else {
      bytes = new Uint8Array(await file.arrayBuffer());
      mediaType = file.type || "application/octet-stream";
    }
    const key = await buildAttachmentKey(bytes, file.name);
    // Page cap BEFORE the upload, not after: without it a 200-page PDF is sent whole to the model,
    // billed in full as input, and only then fails on the OUTPUT ceiling — you pay for everything
    // and get nothing back. openPdf is already in the browser bundle for the in-app viewer, so the
    // count is free, and the SAME open is what renders the pages below when the model needs them.
    // A PDF pdfjs cannot open at all is let through — the reader may still manage it.
    let pdf: PdfDoc | null = null;
    if (mediaType === "application/pdf" || /\.pdf$/i.test(file.name)) {
      try {
        // bytes.slice(), NOT bytes: pdf.js TRANSFERS the array it is handed to its worker, which
        // detaches the underlying ArrayBuffer and leaves the caller's view zero-length. Passing the
        // original meant the PUT below then uploaded an empty body, and /api/raw rejected it —
        // "storing the attachment failed (400)" on every PDF, with nothing pointing at the page
        // count as the cause. slice() copies, so the bytes we upload are untouched.
        pdf = await openPdf(bytes.slice());
      } catch {
        // Left null — see above.
      }
      if (pdf !== null && pdf.numPages > MAX_DOCUMENT_PAGES) {
        throw new Error(`"${file.name}" is ${pdf.numPages} pages — split it and attach up to ${MAX_DOCUMENT_PAGES} pages at a time`);
      }
    }
    // pdf is already open for the page cap above, so the count the corpus needs is free here.
    await uploadAttachment(clientId, bytes, key, pdf?.numPages);
    const attachment: Attachment = { key, name: file.name, mediaType, bytes: bytes.length, addedAt: new Date().toISOString() };
    out.push(opts?.extractDocuments === false ? attachment : await withExtraction(clientId, attachment, pdf));
  }
  return out;
}

/**
 * Reads a document's contents once, at attach time, and stamps the metadata onto the attachment.
 *
 * Here rather than at each consumer because the extraction is cached by CONTENT key server-side:
 * doing it once on attach means every later surface — a leaf turn, a chat send, the UI — finds a
 * sidecar already waiting and never pays for a model call in the middle of answering a question.
 *
 * A failure is recorded, not thrown: the file is already uploaded and the user asked to attach it,
 * not to read it. `extracted.error` is what lets the UI say "couldn't read this" instead of leaving
 * a document that silently contributes nothing.
 */
async function withExtraction(clientId: string, attachment: Attachment, pdf: PdfDoc | null): Promise<Attachment> {
  if (!isExtractableDocument(attachment)) return attachment;
  // A deployment whose document model can take neither PDFs nor images will refuse this with 422;
  // record that once, here, rather than paying an upload-and-refuse round trip per attachment.
  if (!supports("document", "documents")) {
    return { ...attachment, extracted: { at: new Date().toISOString(), chars: 0, error: ABILITY_UNAVAILABLE.documents } };
  }
  try {
    // A model that sees but cannot take a PDF is sent the pages instead — rendered here, from the
    // open document above, because the relay's runtime has no pdfjs.
    const pageImages = pdf && needsPageImages("document") ? await renderOpenPdfPages(pdf) : undefined;
    return { ...attachment, extracted: extractedMetadata(await extractDocument(clientId, attachment, pageImages)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not be read";
    return { ...attachment, extracted: { at: new Date().toISOString(), chars: 0, error: message } };
  }
}

/** True when this attachment carries text a turn can quote. */
export function hasExtractedText(a: Attachment): boolean {
  return !!a.extracted && !a.extracted.error && a.extracted.chars > 0;
}

export { isExtractableDocument, isPdfAttachment };
// W68 — moved to attachment-keys.ts so the Node CLI can import them without pulling this module's
// browser fetch dependencies. Re-exported here so every browser caller keeps its existing import.
export { appendAttachments, attachmentsOf, groupAttachmentsOf, attachmentKeysOf, isLastRawCaptureAttachment, isLastRawCaptureHolder } from "./attachment-keys";
