// What a cross-store copy may touch in one namespace, decided from four sets and nothing else.
//
// Separated from the two halves beside it because this is the whole of the safety argument and the
// only part a test can reach: both halves need a live bucket, a live D1 and the organisation's key,
// so a rule that lives inside either of them is a rule nothing holds to anything.
//
// THE FOUR QUESTIONS, which are deliberately four and not one:
//   named    — does the TARGET's record ask for this file? A file it does not name would be bytes
//              nothing in production ever fetches, and writing them is a disclosure with no reader.
//   present  — does the target bucket already hold it? Nothing here ever overwrites an object: a
//              key is content-addressed, so a file already there is already the right bytes.
//   rowed    — does the target have a `raw_objects` ROW for it? A different question from `present`,
//              because the listing route answers from those rows (functions/_lib/identity-audit.ts)
//              and a client that trusts the listing never fetches an object with no row. An object
//              that landed while its row did not is therefore invisible, and `take` excludes
//              anything present — so the row is recorded from here or never.
//   keyed    — does the target vault's ring hold a content key for it? A row for an object the ring
//              cannot open turns a silent omission into a failed fetch and buys nothing.
import type { StagedEntry } from "./raw-copy-manifest";

export interface NamespacePlan {
  /** Named, hash-sound, and absent from the bucket: copy the bytes and record the row. */
  take: StagedEntry[];
  /** Named, hash-sound, present and keyed, but unrecorded: record the row and touch nothing else. */
  heal: StagedEntry[];
  /** Staged files whose own hash does not match the key they claim — never copied, always reported. */
  odd: StagedEntry[];
  /** Every file the record names that the bucket does not hold, whether or not staging can answer it. */
  gap: string[];
}

export interface NamespaceState {
  entries: StagedEntry[];
  /** Attachment keys the target's record names (scripts/record-export.ts's collectAttachments). */
  named: ReadonlySet<string>;
  /** Attachment keys the target bucket holds under this namespace. */
  present: ReadonlySet<string>;
  /** Attachment keys the target has a raw_objects row for. */
  rowed: ReadonlySet<string>;
  /** Attachment keys the target vault's ring holds a content key for. */
  keyed: ReadonlySet<string>;
}

/**
 * True when a staged file's own content hash does not open the key it is filed under.
 *
 * An attachment key IS `${sha256.slice(0,8)}-${safeName}` (src/lib/attachment-store.ts:29-33), so
 * the file carries its own receipt and a copy can check it without asking either store. Only a key
 * of that shape is checked: a key predating content addressing has no hash to disagree with, and
 * treating "cannot be checked" as "failed" would refuse every one of them.
 */
export function hashDisagrees(entry: StagedEntry): boolean {
  if (!/^[0-9a-f]{8}-/.test(entry.file)) return false;
  return !entry.file.startsWith(`${entry.sha256.slice(0, 8)}-`);
}

export function planNamespace(state: NamespaceState): NamespacePlan {
  const { entries, named, present, rowed, keyed } = state;
  const odd = entries.filter(hashDisagrees);
  const sound = entries.filter((e) => named.has(e.file) && !hashDisagrees(e));
  return {
    take: sound.filter((e) => !present.has(e.file)),
    heal: sound.filter((e) => present.has(e.file) && !rowed.has(e.file) && keyed.has(e.file)),
    odd,
    // `gap` minus `take` is the part staging cannot answer: a file the source never held, or one
    // this lane does not carry. Reported so a residue is a number rather than a silence.
    gap: [...named].filter((f) => !present.has(f)),
  };
}
