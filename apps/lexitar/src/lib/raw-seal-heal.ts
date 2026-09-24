// Sealing the originals a store was already holding in plaintext, from the browser.
//
// The operator sweep (scripts/raw-encrypt-backfill.ts) does the same work store-wide, but it needs
// the org recovery key to open a vault. An account that has REVOKED org recovery is unreachable by
// it, by design — so this lane is the only one that ever seals those files, and that is the point of
// having both.
//
// It diffs the namespace's recorded objects against this vault's key ring rather than against the
// record's attachment lists: the corpus reads every `raw_objects` row under the namespace, so an
// object nothing in the record still points at is still an object that can refuse a question.
import { normalizeClientId } from "./client-id";
import { putRaw } from "./attachment-store";
import { fetchStoredBytes } from "./attachment-blob";
import { isSealed } from "./raw-cipher";
import { rawKeysFor } from "./vault-raw-keys";

/** Small: each file is a full download and re-upload of up to 24 MB, behind whatever the user is doing. */
const BATCH = 4;

export interface SealCounts {
  sealed: number;
  /** Sealed under a key this vault no longer holds — the sweep cannot help, and re-sealing would need plaintext. */
  unopenable: number;
}

async function seal(clientId: string, file: string): Promise<keyof SealCounts | null> {
  const stored = await fetchStoredBytes(clientId, file);
  if (isSealed(stored)) return "unopenable";
  // putRaw mints the key, saves it to the vault and only then uploads — the ordering that keeps a
  // sealed object from outliving the key that opens it (vault-raw-keys.ts).
  const res = await putRaw(clientId, file, stored);
  return res.ok || res.status === 204 ? "sealed" : null;
}

/**
 * Seals every plaintext original under one client, returning what it managed.
 *
 * Best effort, like healRawPageCounts: it runs unawaited behind the open record, and a file it fails
 * on stays plaintext and readable, to be retried on the next open. A file whose key was saved but
 * whose upload then failed is the one case this lane skips afterwards — it holds a key, so the diff
 * passes over it — and the operator sweep is what catches those.
 */
export async function healRawSealing(clientId: string): Promise<SealCounts> {
  const id = normalizeClientId(clientId);
  const counts: SealCounts = { sealed: 0, unopenable: 0 };
  const listed = await fetch(`/api/raw/${id}?files=1`).catch(() => null);
  if (!listed?.ok) return counts;
  const { files } = (await listed.json()) as { files: string[] };

  const keys = rawKeysFor(id);
  const plaintext = files.filter((f) => !keys[f]);
  for (let i = 0; i < plaintext.length; i += BATCH) {
    const done = await Promise.all(plaintext.slice(i, i + BATCH).map((f) => seal(id, f).catch(() => null)));
    for (const outcome of done) if (outcome) counts[outcome] += 1;
  }
  return counts;
}
