// A stored original, as something the browser can point an <img>, an <a download> or pdfjs at.
//
// Stored originals are ciphertext under a per-file content key (raw-cipher.ts), so
// `/api/raw/{id}/{key}` is no longer a URL an element can render: the bytes have to be fetched,
// decrypted with the key from this vault's key ring, and handed back as a `blob:` URL. Call sites
// keep the shape they had — one function from (clientId, key) to a URL — now asynchronous.
import { normalizeClientId } from "./client-id";
import { openStored, refreshRawKeyring } from "./vault-raw-keys";
import { RawKeyError } from "./raw-cipher";

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

/** Closing the vault takes the decrypted copies with it. */
export function revokeAttachmentBlobs(): void {
  for (const pending of blobs.values()) void pending.then(URL.revokeObjectURL, () => undefined);
  blobs.clear();
}
