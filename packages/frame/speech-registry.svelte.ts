// The one shared read-aloud player. It mirrors menu-registry.svelte.ts's singleton shape: playing one
// thing stops whatever else was playing.
//
// Text is spoken one chunk (roughly one sentence) at a time, and each chunk's `end` starts the next.
// Chromium silently cuts off a single long utterance after ~15s, and chunking is also what makes
// progress and resume possible. Pause is cancel() plus a remembered index, not
// speechSynthesis.pause(), which is a no-op or broken on Android Chrome and some Linux voices. Resume
// restarts the current chunk.
//
// The engine finishes or fails utterances on its own. cancel()'s `end` also arrives as a separate
// task, after the call that caused it. So every utterance captures the `generation` it was spoken
// under. Each pause, stop, or new play bumps that counter, which makes a late event from a
// superseded chunk a no-op.
//
// An app may configure a SpeechEngine: each chunk is then synthesized to audio (a neural voice) and
// played through an HTMLAudioElement, the next chunk prefetched while the current one plays. If the
// engine or playback fails, the rest of that playback falls back to the browser voice.
export type SpeechStatus = "idle" | "playing" | "paused";

export interface SpeechEngine {
  synthesize(text: string, voice?: string): Promise<Blob>;
  normalize?(text: string): string;
}

const MAX_CHUNK = 200;

const state = $state({
  id: null as string | null,
  label: "",
  status: "idle" as SpeechStatus,
  chunks: [] as string[],
  index: 0,
});
let generation = 0;
let engine: SpeechEngine | null = null;
let voice: string | undefined;
let neural = false;
let audio: HTMLAudioElement | null = null;
let clips = new Map<number, Promise<string>>();

export function configureSpeech(e: SpeechEngine | null): void {
  engine = e;
}

function synth(): SpeechSynthesis | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

export function isSpeechSupported(): boolean {
  return !!engine || !!synth();
}

function pack(parts: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    const next = buf ? `${buf} ${p}` : p;
    if (buf && next.length > MAX_CHUNK) {
      out.push(buf);
      buf = p;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function speechChunks(text: string): string[] {
  const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text), (s) => s.segment.trim())
    .filter(Boolean);
  return pack(sentences.flatMap((s) => (s.length > MAX_CHUNK ? pack(s.split(/\s+/)) : [s])));
}

function halt() {
  generation++;
  synth()?.cancel();
  audio?.pause();
  audio = null;
}

function releaseClips() {
  for (const p of clips.values()) p.then((url) => URL.revokeObjectURL(url), () => {});
  clips = new Map();
}

function reset() {
  releaseClips();
  neural = false;
  state.id = null;
  state.label = "";
  state.status = "idle";
  state.chunks = [];
  state.index = 0;
}

function advance(gen: number) {
  if (gen !== generation) return;
  if (state.index + 1 < state.chunks.length) {
    state.index++;
    speakCurrent();
  } else {
    reset();
  }
}

function speakCurrent() {
  const gen = ++generation;
  if (neural) speakNeural(gen);
  else speakBrowser(gen);
}

function speakBrowser(gen: number) {
  const utterance = new SpeechSynthesisUtterance(state.chunks[state.index]);
  utterance.onend = () => advance(gen);
  utterance.onerror = () => { if (gen === generation) reset(); };
  synth()!.speak(utterance);
}

function clip(i: number): Promise<string> {
  let p = clips.get(i);
  if (!p) {
    p = engine!.synthesize(state.chunks[i], voice).then((blob) => URL.createObjectURL(blob));
    clips.set(i, p);
  }
  return p;
}

function speakNeural(gen: number) {
  const i = state.index;
  clip(i).then((url) => {
    if (gen !== generation) return;
    const a = new Audio(url);
    audio = a;
    a.onended = () => advance(gen);
    a.onerror = () => fallBack(gen);
    a.play().catch(() => fallBack(gen));
    if (i + 1 < state.chunks.length) clip(i + 1).catch(() => {});
  }, () => fallBack(gen));
}

function fallBack(gen: number) {
  if (gen !== generation) return;
  neural = false;
  audio = null;
  if (synth()) speakBrowser(gen);
  else reset();
}

export const speechRegistry = {
  statusOf(id: string): SpeechStatus {
    return state.id === id ? state.status : "idle";
  },
  current() {
    return { id: state.id, label: state.label, status: state.status, index: state.index, total: state.chunks.length };
  },
  play(id: string, text: string, label: string, withVoice?: string): void {
    const chunks = speechChunks(engine?.normalize ? engine.normalize(text) : text);
    if (!isSpeechSupported() || !chunks.length) return;
    halt();
    releaseClips();
    voice = withVoice;
    neural = !!engine;
    Object.assign(state, { id, label, status: "playing", chunks, index: 0 });
    speakCurrent();
  },
  pause(): void {
    if (state.status !== "playing") return;
    halt();
    state.status = "paused";
  },
  resume(): void {
    if (state.status !== "paused" || !isSpeechSupported()) return;
    state.status = "playing";
    speakCurrent();
  },
  toggle(id: string, text: string, label: string, withVoice?: string): void {
    if (state.id !== id) this.play(id, text, label, withVoice);
    else if (state.status === "playing") this.pause();
    else this.resume();
  },
  stop(): void {
    halt();
    reset();
  },
};

// Nothing keeps speaking into a page that is being navigated away from or put in the bfcache.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => speechRegistry.stop());
