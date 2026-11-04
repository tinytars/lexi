// What the record claims to hold, against what the store has a record of.
//
// Nothing asked this question in the browser before. The record names attachments, saves are
// optimistic and whole-record (vault-save.svelte.ts), and an upload refused before its PUT leaves
// the reference behind — so the next successful save of any unrelated edit makes a name with no
// file behind it durable. The read path then answers 404 per key, which is correct and tells
// nobody: the strip renders a document glyph for a file that is gone, and a leaf regen drops it
// from the context and writes a console line (leaf-regen-client.ts). Measured in production as
// thirty-odd keys in one record and an assessment computed twice without four of its documents.
//
// scripts/vault-verify.ts has asked it on the CLI all along, against the same enumeration
// (attachmentKeysOf). This is that check where the person who is owed the answer can see it.
//
// WHAT "MISSING" MEANS HERE, exactly: `?files=1` lists the raw_objects ROWS under the namespace
// (listRawObjectsUnder, functions/api/raw/[[path]].ts:117-119), not the bucket. So a key this
// reports is one the store has no record of at all — the upload-refused case above, which is the
// measured incident. A row whose object the bucket has since lost is a different fault and is the
// operator sweep's question (raw:seal-verify), not this one: the browser cannot tell it from a
// transient read failure, and marking a file gone on a 500 would be a worse lie than saying
// nothing.
import { attachmentKeysOf } from "./attachment-keys";
import { normalizeClientId } from "./client-id";
import type { Client } from "./types";

export interface Reconciliation {
  /** Distinct attachment keys the record names. */
  named: number;
  /** Keys the store has no record of, each with attachmentKeysOf's label for what names it. */
  missing: { key: string; label: string }[];
  /**
   * False when the listing could not be read, in which case `missing` is empty and means nothing.
   *
   * Explicit because the two readings are opposite and a caller cannot tell them apart from an
   * empty array: "every file is there" and "I could not find out" must not both mark a record
   * clean. Offline is the common case, and a record that sprouts warnings on every flaky network
   * would teach its reader to ignore them.
   */
  listed: boolean;
}

export interface ReconcileDeps {
  /** The namespace's recorded keys, or null when the listing could not be read. */
  listFiles?: (clientId: string) => Promise<string[] | null>;
}

async function listRecordedFiles(clientId: string): Promise<string[] | null> {
  // Same route and shape as raw-seal-heal.ts's own listing — keys only, no bytes.
  const res = await fetch(`/api/raw/${normalizeClientId(clientId)}?files=1`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { files?: string[] } | null;
  return body?.files ?? null;
}

/**
 * The pure diff, so the interesting half is testable without a transport.
 *
 * De-duplicates by key and keeps the FIRST label: one file attached to several entries is one
 * missing file, and reporting it once per owner would turn a single loss into a crowd.
 */
export function missingAttachments(
  named: { label: string; key: string }[],
  recorded: Iterable<string>,
): { key: string; label: string }[] {
  const held = new Set(recorded);
  const seen = new Set<string>();
  const out: { key: string; label: string }[] = [];
  for (const { key, label } of named) {
    if (held.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out;
}

/**
 * Reports; never repairs.
 *
 * Deliberately: the two repairs available are removing the reference, which destroys the only
 * record that the file was ever there, and re-uploading, which needs bytes nobody in this process
 * has. Both are the reader's decision, and neither is a thing to do behind their back on a page
 * load.
 */
export async function reconcileAttachments(
  clientId: string,
  client: Client,
  deps: ReconcileDeps = {},
): Promise<Reconciliation> {
  const named = attachmentKeysOf(client);
  const distinct = new Set(named.map((a) => a.key)).size;
  if (named.length === 0) return { named: 0, missing: [], listed: true };
  const recorded = await (deps.listFiles ?? listRecordedFiles)(clientId);
  if (!recorded) return { named: distinct, missing: [], listed: false };
  return { named: distinct, missing: missingAttachments(named, recorded), listed: true };
}
