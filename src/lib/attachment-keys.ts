// The pure half of attachment handling: what an item's attachments ARE, with no notion of fetching or
// uploading them.
//
// W68 — split out because scripts/vault-verify.ts and scripts/ingest.ts need `attachmentKeysOf`, and
// importing it from attachment-store.ts dragged document-extract-client.ts and extract-client.ts into
// the Node CLI's module graph: browser `fetch` modules with relative URLs a CLI can never call. They
// never crashed (the fetch calls are function-scoped) but the CLI carried dead browser transport for
// one helper, and cli-import-graph.test.ts now refuses to let that come back.
//
// attachment-store.ts re-exports all of this, so no browser caller changed.

import type { Attachment, TreatmentItem } from "./types";

const EXT_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", gif: "image/gif", pdf: "application/pdf",
};


// Folds the pre-W46 `TreatmentItem.images: string[]` shape into `Attachment[]` for display — same
// legacy-read-only shim pattern as LegacyFactors (types.ts). New writes always populate
// `attachments` directly; this exists only so an un-migrated vault's old photos keep rendering. No
// backfill script — the shim is cheaper and the repo already carries this pattern elsewhere.
/**
 * The attachments of a whole MEDICINE — the union across its dose rows, de-duplicated by key.
 *
 * A product photo or a COA documents the drug, not the fortnight you happened to be on 6mg, so the
 * group is what owns it. Storage still lives on the rows (there is no medicine record to hang it
 * off), and a medicine-level write mirrors the set onto every row the way name/reason/kind already
 * are — so deleting one dose period never takes the product photo with it. Reading the union is
 * what makes that safe, and what makes already-stored per-row attachments show up correctly with
 * no migration.
 */
export function groupAttachmentsOf(items: Pick<TreatmentItem, "attachments" | "images">[]): Attachment[] {
  const byKey = new Map<string, Attachment>();
  for (const item of items) for (const a of attachmentsOf(item)) if (!byKey.has(a.key)) byKey.set(a.key, a);
  return [...byKey.values()];
}

export function attachmentsOf(item: Pick<TreatmentItem, "attachments" | "images">): Attachment[] {
  if (item.attachments) return item.attachments;
  if (!item.images) return [];
  return item.images.map((key) => {
    const name = key.slice(key.indexOf("-") + 1) || key;
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return {
      key,
      name,
      mediaType: EXT_MEDIA_TYPE[ext] ?? "application/octet-stream",
      bytes: 0,
      addedAt: "",
    };
  });
}

/**
 * Whether removing `key` from `item`'s own attachments would violate report-merge.ts's
 * provenanceIssues check — i.e. leave NONE of `rawCaptureAttachmentKeys` present. Mirrors that
 * check's own `.some()` threshold deliberately: removing one of several surviving raw-capture
 * keys is fine, only the LAST one is blocked. An item that was never photo-extracted, or that
 * already lost its raw capture some other way, has nothing left to block.
 */
export function isLastRawCaptureAttachment(
  item: Pick<TreatmentItem, "attachments" | "rawCaptureAttachmentKeys" | "extracted">,
  key: string,
): boolean {
  if (item.extracted?.via !== "photo") return false;
  const claimed = item.rawCaptureAttachmentKeys;
  if (!claimed?.length || !claimed.includes(key)) return false;
  const remaining = attachmentsOf(item).filter((a) => a.key !== key);
  return !remaining.some((a) => claimed.includes(a.key));
}

/**
 * Whether deleting `item` outright would permanently discard the only surviving raw-capture
 * attachment for its medicine — every OTHER row sharing its name (trimmed/lowercased, matching
 * treatment-bucket.ts's own grouping) has none of ITS OWN claimed keys left either. Deleting a
 * row can never leave a dangling provenanceIssues violation on another row (each row's claim is
 * checked against its own attachments only), so this is a data-loss guard rather than the same
 * CI invariant — losing the evidence a photo extraction was read from is still worth naming.
 */
export function isLastRawCaptureHolder(
  item: Pick<TreatmentItem, "id" | "name" | "attachments" | "rawCaptureAttachmentKeys" | "extracted">,
  siblings: Pick<TreatmentItem, "id" | "name" | "attachments" | "rawCaptureAttachmentKeys" | "extracted">[],
): boolean {
  const hasRawCapture = (t: typeof item) =>
    t.extracted?.via === "photo" && !!t.rawCaptureAttachmentKeys?.length &&
    attachmentsOf(t).some((a) => t.rawCaptureAttachmentKeys!.includes(a.key));
  if (!hasRawCapture(item)) return false;
  const name = item.name.trim().toLowerCase();
  return !siblings.some((s) => s.id !== item.id && s.name.trim().toLowerCase() === name && hasRawCapture(s));
}

/**
 * Every attachment on a client, with a human label for error messages. ONE enumeration: vault-verify
 * checks each of these resolves to a raw file, and ingest's --reconcile materializes them. Those two
 * walked different sets — verify covered all seven owners, reconcile covered none of them (it only
 * iterated `sources`) — so a vault pulled from R2 could reference an attachment the repo would then
 * be permanently faulted for not having. Adding an eighth attachment owner now updates both.
 */
export function attachmentKeysOf(client: {
  factors?: {
    treatments?: { id: string; attachments?: Attachment[]; images?: string[] }[];
    noteEntries?: { id: string; attachments?: Attachment[] }[];
    decisions?: { id?: string; attachments?: Attachment[] }[];
    allergies?: { id: string; attachments?: Attachment[] }[];
    familyHistory?: { id: string; attachments?: Attachment[] }[];
    diseases?: { id: string; attachments?: Attachment[] }[];
  };
  study?: { entries?: { id: string; attachments?: Attachment[] }[] };
}): { label: string; key: string }[] {
  const out: { label: string; key: string }[] = [];
  const push = (label: string, list: Attachment[] | undefined) => {
    for (const a of list ?? []) out.push({ label, key: a.key });
  };
  for (const t of client.factors?.treatments ?? []) push(`treatment ${t.id}`, attachmentsOf(t));
  for (const n of client.factors?.noteEntries ?? []) push(`note ${n.id}`, n.attachments);
  for (const d of client.factors?.decisions ?? []) push(`idea ${d.id}`, d.attachments);
  for (const e of client.study?.entries ?? []) push(`study ${e.id}`, e.attachments);
  for (const a of client.factors?.allergies ?? []) push(`allergy ${a.id}`, a.attachments);
  for (const f of client.factors?.familyHistory ?? []) push(`family ${f.id}`, f.attachments);
  for (const d of client.factors?.diseases ?? []) push(`disease ${d.id}`, d.attachments);
  return out;
}
