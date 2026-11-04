// Which attachment keys the host's store does not hold.
//
// A chip can discover this for an IMAGE by itself: the thumbnail's fetch fails and AttachmentThumb
// renders its ⚠. A document chip cannot. It is a glyph, nothing is fetched until somebody opens the
// viewer, so a document whose bytes are gone looks exactly like one that is fine — while what it is
// actually doing is being left out of whatever the host computes from the record. That is the
// failure this exists for: not an error anybody saw, an answer quietly assembled from less than the
// record claims to hold.
//
// A registry rather than a prop, mirroring menu-registry.svelte.ts: AttachmentStrip has nine call
// sites in the host this fact comes from, and threading it through nine leaf editors would make
// every one of them carry a storage question that is not its subject. Reactive, unlike
// dictate-registry.ts's bare slot, because the answer arrives from a round trip after the chips are
// already on screen.
//
// The host decides what "does not hold" means and is the only side that can: it owns the store, the
// route that lists it, and the record that names the keys. This module holds the answer and nothing
// else — it never fetches. An empty set is both the initial state and the right reading for a host
// that has never asked, so a host that does not reconcile at all renders exactly as before.
const state = $state<{ keys: ReadonlySet<string> }>({ keys: new Set() });

/**
 * Replaces the whole set.
 *
 * Not an add-one call: a reconciliation answers for every key the record names at once, and a key
 * that has since arrived has to stop being reported. Adding incrementally could only ever grow the
 * set, which would leave a ⚠ on a file somebody re-uploaded.
 */
export function setMissingAttachments(keys: Iterable<string>): void {
  state.keys = new Set(keys);
}

export function isAttachmentMissing(key: string): boolean {
  return state.keys.has(key);
}

/** How many of the reconciled record's attachments the store does not hold. */
export function missingAttachmentCount(): number {
  return state.keys.size;
}

/** Forgets the answer — for when the record it was about is closed, or another one is opened. */
export function clearMissingAttachments(): void {
  state.keys = new Set();
}
