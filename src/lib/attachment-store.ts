// W46 Phase 3 — generalizes treatment-image-store.ts (M54/5, treatment-photo-only) into the shared
// browser-side helper for every leaf's Attach flow, wrapping the /api/raw/{id}/{file} PUT/GET/DELETE
// contract (functions/api/raw/[[path]].ts). Keys mirror PendingUpload.file (types.ts):
// "<sha8>-<safeName>" under raw/{id}/. GET is not wrapped here — the UI builds attachmentUrl()
// directly for <img src>/download links.
import { hashSourceWeb } from "@pablotech/akesi-pil/ingest-core";
import { compressImage } from "./image-compress";
import { bytesToBase64 } from "./extract-client";
import { openPdf } from "@tinytars/frame/pdf-render";
import { MAX_DOCUMENT_PAGES } from "@pablotech/akesi-pil/document-read";
import { extractDocument, extractedMetadata, isExtractableDocument, isPdfAttachment } from "./document-extract-client";
import { normalizeClientId } from "./client-id";
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

export async function uploadAttachment(clientId: string, bytes: Uint8Array, key: string): Promise<void> {
  const res = await fetch(`/api/raw/${normalizeClientId(clientId)}/${key}`, {
    method: "PUT",
    // /api/raw is gated by the hd_session cookie (W44) — same-origin fetch sends it automatically.
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`storing the attachment failed (${res.status})`);
  }
}

export function attachmentUrl(clientId: string, key: string): string {
  return `/api/raw/${normalizeClientId(clientId)}/${encodeURIComponent(key)}`;
}

// W46 Phase 6 — chat vision needs an attachment's bytes back as base64 for an Anthropic `image`
// content block (functions/api/chat.ts). Unlike treatment-image-client.ts's inference relay
// (which base64s bytes already in hand, pre-upload), a chat attachment is uploaded once at Attach
// time and re-fetched here whenever it needs to ride along with a question — including every time
// a PRIOR turn's image is resent as conversation history, since Anthropic has no server-side
// image cache across turns.
export async function fetchAttachmentBase64(clientId: string, key: string): Promise<string> {
  const res = await fetch(attachmentUrl(clientId, key));
  if (!res.ok) throw new Error(`fetching the attachment failed (${res.status})`);
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
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
    // count is free. A PDF pdfjs cannot open at all is let through — the reader may still manage it.
    if (mediaType === "application/pdf" || /\.pdf$/i.test(file.name)) {
      let pages: number | null = null;
      try {
        // bytes.slice(), NOT bytes: pdf.js TRANSFERS the array it is handed to its worker, which
        // detaches the underlying ArrayBuffer and leaves the caller's view zero-length. Passing the
        // original meant the PUT below then uploaded an empty body, and /api/raw rejected it —
        // "storing the attachment failed (400)" on every PDF, with nothing pointing at the page
        // count as the cause. slice() copies, so the bytes we upload are untouched.
        pages = (await openPdf(bytes.slice())).numPages;
      } catch {
        pages = null;
      }
      if (pages !== null && pages > MAX_DOCUMENT_PAGES) {
        throw new Error(`"${file.name}" is ${pages} pages — split it and attach up to ${MAX_DOCUMENT_PAGES} pages at a time`);
      }
    }
    await uploadAttachment(clientId, bytes, key);
    const attachment: Attachment = { key, name: file.name, mediaType, bytes: bytes.length, addedAt: new Date().toISOString() };
    out.push(opts?.extractDocuments === false ? attachment : await withExtraction(clientId, attachment));
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
async function withExtraction(clientId: string, attachment: Attachment): Promise<Attachment> {
  if (!isExtractableDocument(attachment)) return attachment;
  try {
    return { ...attachment, extracted: extractedMetadata(await extractDocument(clientId, attachment)) };
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
export { attachmentsOf, groupAttachmentsOf, attachmentKeysOf, isLastRawCaptureAttachment, isLastRawCaptureHolder } from "./attachment-keys";
