// Extracted from three identical guards in App.svelte (translateMarker, handleCategorizeMarkers,
// doRefresh's save callback — W79 phase 3b), each written as `if (currentClient !== c) return;` with a
// comment about the provider switching patients mid-request. Reference equality is correct for more
// than that one case: `currentClient` is a fresh object on every edit too (saveEdits swaps in a new
// `vault`), so this also catches "a different edit to the SAME patient landed while this request was in
// flight" — applying this request's result on top of the captured (now-stale) snapshot would silently
// revert that other edit. Both are the same hazard: don't save based on a client snapshot that is no
// longer the live one.

export function patientSwitchedMidRequest<T>(current: T | null | undefined, captured: T): boolean {
  return current !== captured;
}
