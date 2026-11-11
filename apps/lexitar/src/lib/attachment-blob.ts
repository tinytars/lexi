// A stored original, as something the browser can point an <img>, an <a download> or pdfjs at.
//
// Stored originals are ciphertext under a per-file content key (raw-cipher.ts), so
// `/api/raw/{id}/{key}` is no longer a URL an element can render: the bytes have to be fetched,
// decrypted with the key from this vault's key ring, and handed back as a `blob:` URL. Call sites
// keep the shape they had — one function from (clientId, key) to a URL — now asynchronous.
import { normalizeClientId } from "./client-id";
import { openStored, rawKeyFor, refreshRawKeyring } from "./vault-raw-keys";
import { RawKeyError, sealRaw } from "./raw-cipher";
import { compressImage } from "./image-compress";

const rawUrl = (clientId: string, key: string): string => `/api/raw/${normalizeClientId(clientId)}/${encodeURIComponent(key)}`;

/** The bytes as STORED — still sealed if the store holds them sealed. The sealing sweep needs these. */
export async function fetchStoredBytes(clientId: string, key: string): Promise<Uint8Array> {
  const res = await fetch(rawUrl(clientId, key));
  if (!res.ok) throw new Error(`fetching the attachment failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The PLAINTEXT bytes of one stored original, whichever format the store currently holds it in.
 *
 * A key this page does not hold is retried ONCE against a re-read vault, because the usual reason is
 * that the operator sweep recorded it after this page opened (vault-raw-keys.ts). Without the retry
 * an already-rendered attachment stays broken until the tab is reloaded, even though the vault holds
 * what opens it. A key still missing after the re-read is a genuine refusal and propagates.
 */
export async function fetchAttachmentBytes(clientId: string, key: string): Promise<Uint8Array> {
  const stored = await fetchStoredBytes(clientId, key);
  try {
    return await openStored(stored, clientId, key);
  } catch (e) {
    if (!(e instanceof RawKeyError) || e.reason !== "missing") throw e;
    await refreshRawKeyring();
    return openStored(stored, clientId, key);
  }
}

// Keyed by client and file, holding the PROMISE rather than the URL so two surfaces opening the
// same attachment in the same tick share one fetch and one decrypt.
const blobs = new Map<string, Promise<string>>();

/**
 * A `blob:` URL for one stored original, minted once per page.
 *
 * Not revoked when a component unmounts: attachment keys are content-addressed, so a URL can never
 * go stale, and revoking on unmount would break every other surface still showing the same file —
 * the strip, the viewer and the download link all point at one attachment. Revocation is tied to
 * the VAULT instead (`revokeAttachmentBlobs`), which is the moment decrypted PHI should stop being
 * addressable from this page.
 */
export function attachmentBlobUrl(clientId: string, key: string): Promise<string> {
  const id = `${normalizeClientId(clientId)}/${key}`;
  const hit = blobs.get(id);
  if (hit) return hit;
  const minted = fetchAttachmentBytes(clientId, key)
    .then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart])))
    .catch((err) => {
      // A failed fetch is not cached: the key may arrive with the next save, or the network may
      // come back, and caching the failure would leave the file permanently blank for this page.
      blobs.delete(id);
      throw err;
    });
  blobs.set(id, minted);
  return minted;
}

// A 56px chip. The stored original is a 1024px photograph averaging 168 KB, so the chip was asking
// for roughly thirty times the data its own pixels can show, once per chip, on a phone.
const THUMB_MAX_DIM = 160;
const THUMB_QUALITY = 0.6;

// Its own map, for the same reason `blobs` has one (:39-40) and keyed the same way: two strips
// drawing the same attachment in one tick share one fetch and one decrypt. Separate from `blobs`
// because they hold different artefacts of the same file — the chip wants the thumbnail and the
// viewer wants the original, and collapsing them would hand one of the two the wrong picture.
const thumbs = new Map<string, Promise<string>>();

/**
 * Injected rather than imported at the call site, in uploadPendingImages's shape
 * (treatment-attachment-upload.ts:13-18) and for its stated reason: what is worth testing here is
 * the fallback and the write-once, not the resize. There is no `OffscreenCanvas` in the node test
 * environment, so a suite that could not replace this could not run at all.
 */
export interface ThumbDeps {
  compressImage: (file: Blob, maxDim?: number, quality?: number) => Promise<{ bytes: Uint8Array; mediaType: string }>;
}

/**
 * A `blob:` URL for one attachment's CHIP-SIZED copy, minted once per page.
 *
 * Three paths, and the second is the one that makes the first true of photographs that already
 * exist. A stored thumbnail is one request of about 6 KB. A 404 — every attachment uploaded before
 * this shipped — paints from the original, so the chip is never worse than it was, and then seals a
 * thumbnail from the SAME decrypted buffer so no later view pays again. One write per image ever.
 *
 * The write is deliberately not the caller's business and its failure is deliberately swallowed: a
 * chip that has already painted must not fail because an optimisation did not land, and the next
 * view retries by construction. The route refuses the write unless the caller owns the namespace
 * (functions/api/raw/[[path]].ts), so a clinician reading under a consent grant keeps falling back
 * forever — slow and correct, rather than writing a derivative into somebody else's record.
 */
export function attachmentThumbUrl(clientId: string, key: string, deps: ThumbDeps = { compressImage }): Promise<string> {
  const id = `${normalizeClientId(clientId)}/${key}`;
  const hit = thumbs.get(id);
  if (hit) return hit;
  const minted = resolveThumb(clientId, key, deps).catch((err) => {
    // Not cached, for `attachmentBlobUrl`'s reason at :59-60: the key may arrive with the next save.
    thumbs.delete(id);
    throw err;
  });
  thumbs.set(id, minted);
  return minted;
}

async function resolveThumb(clientId: string, key: string, deps: ThumbDeps): Promise<string> {
  const res = await fetch(`${rawUrl(clientId, key)}?thumb=1`);
  if (res.ok) {
    const stored = new Uint8Array(await res.arrayBuffer());
    // The thumbnail is sealed under the ORIGINAL's content key, which is why this is `key` and not a
    // key of its own: one ring entry opens both, and the thumbnail rotates and is revoked with the
    // picture it came from rather than needing its own lifecycle.
    return URL.createObjectURL(new Blob([(await openStored(stored, clientId, key)) as BlobPart]));
  }
  if (res.status !== 404) throw new Error(`fetching the attachment thumbnail failed (${res.status})`);

  const bytes = await fetchAttachmentBytes(clientId, key);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  // Registered under `blobs`' own id so the viewer and the download link share this decrypt instead
  // of paying for a second one; never overwritten, because an entry already there is a URL other
  // surfaces are holding.
  const originalId = `${normalizeClientId(clientId)}/${key}`;
  if (!blobs.has(originalId)) blobs.set(originalId, Promise.resolve(url));
  void sealThumb(clientId, key, bytes, deps);
  return url;
}

async function sealThumb(clientId: string, key: string, bytes: Uint8Array, deps: ThumbDeps): Promise<void> {
  try {
    // Nothing is minted. A namespace whose content key this page does not hold simply does not
    // self-heal — the alternative would be a second key for a derivative of bytes we cannot prove we
    // were entitled to read, which is the one thing a key ring must never acquire.
    const contentKey = rawKeyFor(clientId, key);
    if (!contentKey) return;
    const { bytes: small } = await deps.compressImage(new Blob([bytes as BlobPart]), THUMB_MAX_DIM, THUMB_QUALITY);
    await fetch(`${rawUrl(clientId, key)}?thumb=1`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: (await sealRaw(small, contentKey)) as BodyInit,
    });
  } catch {
    // Swallowed on purpose; see attachmentThumbUrl's own note.
  }
}

/** Closing the vault takes the decrypted copies with it — thumbnails included, being vault-keyed
 *  content like any other and addressable from this page until they are revoked. */
export function revokeAttachmentBlobs(): void {
  for (const pending of [...blobs.values(), ...thumbs.values()]) void pending.then(URL.revokeObjectURL, () => undefined);
  blobs.clear();
  thumbs.clear();
}
