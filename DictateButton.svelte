<script lang="ts">
  import { claimDictation, releaseDictation } from "./dictate-registry";

  // W51 — SpeechRecognition (unlike SpeechSynthesis) isn't in TypeScript's own DOM lib — it's a
  // non-standardized, Chromium/Safari-only API (Firefox has neither `SpeechRecognition` nor
  // `webkitSpeechRecognition` at all). Minimal ambient shape for just what this component uses.
  interface SpeechRecognitionResult { 0: { transcript: string }; isFinal: boolean }
  interface SpeechRecognitionEvent extends Event { results: ArrayLike<SpeechRecognitionResult>; resultIndex: number }
  interface SpeechRecognitionLike extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((e: SpeechRecognitionEvent) => void) | null;
    onerror: ((e: Event) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  }
  type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

  function recognitionCtor(): SpeechRecognitionCtor | undefined {
    if (typeof window === "undefined") return undefined;
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }
  const supported = !!recognitionCtor();

  // W51 — dictation appends rather than replaces (decision #4, the milestone plan): never silently
  // destroys something the user already typed. onResult fires once, with the accumulated final
  // transcript, when the session ends (manual stop or the browser's own silence-timeout onend).
  interface Props {
    onResult: (text: string) => void;
    lang?: string;
    title?: string;
  }
  let { onResult, lang, title = "Dictate" }: Props = $props();

  let listening = $state(false);
  let error = $state<string | null>(null);
  let recognition: SpeechRecognitionLike | null = null;
  let finalText = "";

  function stop() {
    recognition?.stop();
  }

  function start() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    error = null;
    finalText = "";
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    if (lang) r.lang = lang;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText = finalText ? `${finalText} ${result[0].transcript}` : result[0].transcript;
      }
    };
    r.onerror = () => {
      // Permission-denied or no-speech-detected both land here — surface a brief inline message
      // rather than throwing; the session is already over by the time onerror fires.
      error = "Couldn't hear you — check mic permission and try again.";
    };
    r.onend = () => {
      listening = false;
      releaseDictation(stop);
      recognition = null;
      if (finalText.trim()) onResult(finalText.trim());
    };
    recognition = r;
    try {
      claimDictation(stop);
      r.start();
      listening = true;
    } catch {
      // W51 — .start() throws synchronously if called while another recognition on the SAME
      // instance is already active, or the browser denies it outright; fail soft, no crash.
      error = "Dictation isn't available right now.";
      listening = false;
      releaseDictation(stop);
      recognition = null;
    }
  }

  function toggle() {
    if (listening) stop();
    else start();
  }
</script>

{#if supported}
  <button
    type="button"
    class="dictate-btn"
    class:listening
    {title}
    aria-label={title}
    aria-pressed={listening}
    onmousedown={(e) => e.preventDefault()}
    onclick={toggle}
  >{listening ? "🔴" : "🎤"}</button>
  {#if error}<span class="dictate-error">{error}</span>{/if}
{/if}

<style>
  .dictate-btn {
    flex-shrink: 0; border: none; background: none; cursor: pointer;
    font-size: 1rem; line-height: 1; padding: 0.35rem; border-radius: 6px;
    color: var(--muted);
  }
  .dictate-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--fg); }
  .dictate-btn.listening {
    color: var(--alert);
    animation: dictate-pulse 1.2s ease-in-out infinite;
  }
  @keyframes dictate-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  .dictate-error { font-size: 0.72rem; color: var(--alert); margin-left: 0.3rem; }
</style>
