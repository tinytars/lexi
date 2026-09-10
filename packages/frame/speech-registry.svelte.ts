// The one shared "who's currently speaking" registry, mirroring menu-registry.svelte.ts's
// singleton shape: starting a new utterance stops whatever else was speaking, and clicking the
// currently-speaking bubble's own button again stops it (toggle) — the same "only one thing
// active" convention a popover-heavy UI wants for this too.
//
// speechSynthesis is a real, global, OS-level engine — it can finish an utterance (or fail) entirely
// on its own, not just via a manual stop() call. `onend`/`onerror` on the utterance are what keep
// `speakingId` in sync with reality in that case; a plain isSpeaking() flag flipped only at the two
// call sites (speak/stop) would go stale the instant a normal utterance finishes.
const state = $state<{ speakingId: string | null }>({ speakingId: null });

function synth(): SpeechSynthesis | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

export function isSpeechSupported(): boolean {
  return !!synth();
}

export const speechRegistry = {
  isSpeaking(id: string): boolean {
    return state.speakingId === id;
  },
  speak(id: string, text: string): void {
    const s = synth();
    if (!s || !text.trim()) return;
    // cancel()'s `end` event is dispatched as its own task, never inside this call — which is what
    // makes the toggle below reachable, since it compares against a speakingId this cancel has not
    // had the chance to clear. The old speakingId is cleared by the assignment further down (or by
    // the toggle); each handler guards on its own id so a late `end` cannot clear a newer utterance.
    // (An earlier version of this comment claimed the opposite, that cancel() fires onend
    // SYNCHRONOUSLY and that this is what clears the old id. Were that true the toggle would be
    // dead code and a second click would re-speak.)
    s.cancel();
    if (state.speakingId === id) {
      // Toggle: clicking the already-speaking bubble's own button again just stops it.
      state.speakingId = null;
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => { if (state.speakingId === id) state.speakingId = null; };
    utterance.onerror = () => { if (state.speakingId === id) state.speakingId = null; };
    state.speakingId = id;
    s.speak(utterance);
  },
  stop(): void {
    synth()?.cancel();
    state.speakingId = null;
  },
};
