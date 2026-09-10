// Only one field dictates at a time: starting a new recognition session stops whichever other
// field's was in progress. Plain closure-based coordinator, not $state — unlike
// speech-registry.svelte.ts (where every caller of the reactive registry needs to know whether IT
// is the one currently speaking), only the single DictateButton that's listening needs to react to
// being stopped, and it already gets that from its own SpeechRecognition's `onend`. Mirrors
// attach-controller.ts's shape (a bare singleton callback slot), not menu-registry's.
let activeStop: (() => void) | null = null;

export function claimDictation(stop: () => void): void {
  activeStop?.();
  activeStop = stop;
}

export function releaseDictation(stop: () => void): void {
  if (activeStop === stop) activeStop = null;
}
