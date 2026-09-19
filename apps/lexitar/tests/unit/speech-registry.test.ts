/**
 * @vitest-environment jsdom
 */
// The read-aloud player. What an e2e cannot reach: the OS speech engine finishes (or fails) each
// utterance whenever it likes, and cancel()'s `end` event arrives as its own task, after the call
// that caused it. The fake engine below models exactly that, so a stale `end` from a chunk that was
// paused or superseded is delivered the way a real browser delivers it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { speechRegistry, speechChunks, isSpeechSupported, configureSpeech } from "@tinytars/frame/speech-registry.svelte";

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: ((e: { name: string; charIndex: number }) => void) | null = null;
  constructor(public text: string) {}
}

function fakeSynth() {
  const spoken: FakeUtterance[] = [];
  let current: FakeUtterance | null = null;
  return {
    spoken,
    cancels: 0,
    speak(u: FakeUtterance) {
      current = u;
      spoken.push(u);
    },
    cancel() {
      this.cancels++;
      const u = current;
      current = null;
      if (u) queueMicrotask(() => u.onend?.());
    },
    /** The engine finishing the current utterance on its own — no call site involved. */
    finish() {
      const u = current;
      current = null;
      u?.onend?.();
    },
    /** The engine reporting it has reached the word starting at `charIndex` of the current utterance. */
    boundary(charIndex: number) {
      current?.onboundary?.({ name: "word", charIndex });
    },
    fail() {
      const u = current;
      current = null;
      u?.onerror?.();
    },
  };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));
const THREE = "First sentence here. Second sentence here. Third sentence here.";

let synth: ReturnType<typeof fakeSynth>;

beforeEach(() => {
  speechRegistry.stop();
  synth = fakeSynth();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
});

describe("speechChunks", () => {
  it("gives each sentence its own chunk, so a voice without word boundaries still resumes mid-text", () => {
    expect(speechChunks("Hello there. How are you?")).toEqual(["Hello there.", "How are you?"]);
  });

  it("hard-splits a single overlong sentence at whitespace", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const chunks = speechChunks(words);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join(" ")).toBe(words);
  });

  it("drops whitespace-only text", () => {
    expect(speechChunks("   \n ")).toEqual([]);
  });
});

describe("support", () => {
  it("reports unsupported when the engine is absent, and play is a no-op", () => {
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    expect(isSpeechSupported()).toBe(false);
    speechRegistry.play("a", "hello", "A");
    expect(speechRegistry.statusOf("a")).toBe("idle");
  });

  it("reports supported when it is present", () => {
    expect(isSpeechSupported()).toBe(true);
  });
});

// Three sentences of ~150 chars each, so each is its own chunk.
const LONG = ["One", "Two", "Three"].map((w) => `${w} ${"x".repeat(150)}.`).join(" ");

describe("playing", () => {
  it("speaks the text, marks that id as playing, and exposes label and progress", () => {
    speechRegistry.play("a", "hello", "Lexi");
    expect(synth.spoken.map((u) => u.text)).toEqual(["hello"]);
    expect(speechRegistry.statusOf("a")).toBe("playing");
    expect(speechRegistry.statusOf("b")).toBe("idle");
    expect(speechRegistry.current()).toEqual({ id: "a", label: "Lexi", status: "playing", index: 0, total: 1 });
  });

  it("refuses whitespace-only text without disturbing what is playing", () => {
    speechRegistry.play("a", "hello", "A");
    speechRegistry.play("b", "   ", "B");
    expect(synth.spoken).toHaveLength(1);
    expect(speechRegistry.statusOf("a")).toBe("playing");
  });

  it("speaks chunks in sequence, advancing on each end, and returns to idle after the last", () => {
    speechRegistry.play("a", LONG, "A");
    expect(speechRegistry.current().total).toBe(3);
    synth.finish();
    expect(speechRegistry.current().index).toBe(1);
    synth.finish();
    expect(speechRegistry.current().index).toBe(2);
    synth.finish();
    expect(synth.spoken.map((u) => u.text.split(" ")[0])).toEqual(["One", "Two", "Three"]);
    expect(speechRegistry.statusOf("a")).toBe("idle");
    expect(speechRegistry.current().status).toBe("idle");
  });

  it("is a singleton: playing one stops the other", () => {
    speechRegistry.play("a", "hello", "A");
    speechRegistry.play("b", "goodbye", "B");
    expect(speechRegistry.statusOf("a")).toBe("idle");
    expect(speechRegistry.statusOf("b")).toBe("playing");
  });

  it("clears to idle when an utterance errors", () => {
    speechRegistry.play("a", LONG, "A");
    synth.fail();
    expect(speechRegistry.statusOf("a")).toBe("idle");
  });
});

describe("pause and resume", () => {
  const ONE = "The quick brown fox jumps over the lazy dog";

  it("resumes one word before the word it paused on, not from the start", async () => {
    speechRegistry.play("a", ONE, "A");
    synth.boundary(ONE.indexOf("fox"));
    synth.boundary(ONE.indexOf("jumps"));
    speechRegistry.pause();
    await flush();
    speechRegistry.resume();
    expect(synth.spoken.at(-1)!.text).toBe("fox jumps over the lazy dog");
  });

  it("keeps rewinding correctly across a second pause, since boundaries then index the resumed slice", async () => {
    speechRegistry.play("a", ONE, "A");
    synth.boundary(ONE.indexOf("jumps"));
    speechRegistry.pause();
    await flush();
    speechRegistry.resume();
    const resumed = synth.spoken.at(-1)!.text;
    synth.boundary(resumed.indexOf("lazy"));
    speechRegistry.pause();
    await flush();
    speechRegistry.resume();
    expect(synth.spoken.at(-1)!.text).toBe("the lazy dog");
  });

  it("resumes from the start of the current sentence when the voice reports no boundaries", async () => {
    speechRegistry.play("a", THREE, "A");
    synth.finish();
    speechRegistry.pause();
    await flush();
    speechRegistry.resume();
    expect(synth.spoken.at(-1)!.text).toBe("Second sentence here.");
  });

  it("a boundary from a cancelled utterance does not move the resume point", async () => {
    speechRegistry.play("a", ONE, "A");
    const first = synth.spoken[0];
    speechRegistry.pause();
    first.onboundary?.({ name: "word", charIndex: ONE.indexOf("lazy") });
    await flush();
    speechRegistry.resume();
    expect(synth.spoken.at(-1)!.text).toBe(ONE);
  });

  it("plays from the very start again after a stop", () => {
    speechRegistry.play("a", ONE, "A");
    synth.boundary(ONE.indexOf("lazy"));
    speechRegistry.stop();
    speechRegistry.toggle("a", ONE, "A");
    expect(synth.spoken.at(-1)!.text).toBe(ONE);
  });

  it("resumes from the paused chunk, not from the start", async () => {
    speechRegistry.play("a", LONG, "A");
    synth.finish();
    speechRegistry.pause();
    expect(speechRegistry.statusOf("a")).toBe("paused");
    await flush();
    speechRegistry.resume();
    expect(speechRegistry.statusOf("a")).toBe("playing");
    expect(synth.spoken.at(-1)!.text.startsWith("Two")).toBe(true);
  });

  it("a late end from the chunk cancelled by pause neither advances nor clears", async () => {
    speechRegistry.play("a", LONG, "A");
    speechRegistry.pause();
    await flush();
    expect(speechRegistry.current()).toMatchObject({ status: "paused", index: 0 });
    expect(synth.spoken).toHaveLength(1);
  });

  it("a late end from a superseded utterance does not touch the one now playing", async () => {
    speechRegistry.play("a", LONG, "A");
    const first = synth.spoken[0];
    speechRegistry.play("b", LONG, "B");
    first.onend?.();
    await flush();
    expect(speechRegistry.current()).toMatchObject({ id: "b", status: "playing", index: 0 });
  });

  it("pause and resume are no-ops from the wrong state", () => {
    speechRegistry.resume();
    expect(synth.spoken).toHaveLength(0);
    speechRegistry.pause();
    expect(speechRegistry.current().status).toBe("idle");
  });
});

describe("toggle", () => {
  it("cycles idle → playing → paused → playing on the same id", async () => {
    speechRegistry.toggle("a", THREE, "A");
    expect(speechRegistry.statusOf("a")).toBe("playing");
    speechRegistry.toggle("a", THREE, "A");
    expect(speechRegistry.statusOf("a")).toBe("paused");
    await flush();
    speechRegistry.toggle("a", THREE, "A");
    expect(speechRegistry.statusOf("a")).toBe("playing");
  });

  it("toggling another id switches playback to it", () => {
    speechRegistry.toggle("a", "hello", "A");
    speechRegistry.toggle("b", "goodbye", "B");
    expect(speechRegistry.statusOf("a")).toBe("idle");
    expect(speechRegistry.statusOf("b")).toBe("playing");
  });
});

describe("stop", () => {
  it("cancels the engine and returns to idle from playing or paused", async () => {
    speechRegistry.play("a", LONG, "A");
    speechRegistry.stop();
    expect(synth.cancels).toBeGreaterThan(0);
    expect(speechRegistry.current().status).toBe("idle");

    speechRegistry.play("a", LONG, "A");
    speechRegistry.pause();
    speechRegistry.stop();
    await flush();
    expect(speechRegistry.current().status).toBe("idle");
  });

  it("happens on pagehide", () => {
    speechRegistry.play("a", "hello", "A");
    window.dispatchEvent(new Event("pagehide"));
    expect(speechRegistry.statusOf("a")).toBe("idle");
  });

  it("is harmless with nothing playing, and with no engine at all", () => {
    speechRegistry.stop();
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    expect(() => speechRegistry.stop()).not.toThrow();
  });
});

// The neural path: each chunk is synthesized to a Blob by the app's engine and played through an
// audio element. The fake audio element below plays only when told to, like the fake engine above.
class FakeAudio {
  static played: FakeAudio[] = [];
  static refusePlay = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  currentTime = 0;
  constructor(public src: string) {}
  play() {
    if (FakeAudio.refusePlay) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    FakeAudio.played.push(this);
    return Promise.resolve();
  }
  pause() { this.paused = true; }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("neural engine", () => {
  let synthesized: { text: string; voice?: string }[];
  let failSynthesis: boolean;
  let revoked: string[];

  beforeEach(() => {
    synthesized = [];
    failSynthesis = false;
    revoked = [];
    FakeAudio.played = [];
    FakeAudio.refusePlay = false;
    vi.stubGlobal("Audio", FakeAudio);
    let n = 0;
    URL.createObjectURL = () => `blob:${n++}`;
    URL.revokeObjectURL = (u: string) => { revoked.push(u); };
    configureSpeech({
      synthesize: async (text, voice) => {
        synthesized.push({ text, voice });
        if (failSynthesis) throw new Error("503");
        return new Blob([text]);
      },
    });
  });

  afterEach(() => {
    speechRegistry.stop();
    configureSpeech(null);
  });

  it("synthesizes with the requested voice, prefetches the next chunk, and plays chunks in order", async () => {
    speechRegistry.play("a", LONG, "Cody", "voice-k");
    await settle();
    expect(FakeAudio.played).toHaveLength(1);
    expect(synthesized.map((s) => s.text.split(" ")[0])).toEqual(["One", "Two"]);
    expect(synthesized.every((s) => s.voice === "voice-k")).toBe(true);
    FakeAudio.played[0].onended!();
    await settle();
    FakeAudio.played[1].onended!();
    await settle();
    expect(synthesized.map((s) => s.text.split(" ")[0])).toEqual(["One", "Two", "Three"]);
    FakeAudio.played[2].onended!();
    await settle();
    expect(speechRegistry.statusOf("a")).toBe("idle");
    expect(synth.spoken).toHaveLength(0);
    expect(revoked.sort()).toEqual(["blob:0", "blob:1", "blob:2"]);
  });

  it("is supported with an engine even when the browser has no voice", () => {
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    expect(isSpeechSupported()).toBe(true);
  });

  it("normalizes text before chunking, on both paths", async () => {
    configureSpeech({ synthesize: async () => { throw new Error("down"); }, normalize: (t) => t.replace("mg/dL", "milligrams per deciliter") });
    speechRegistry.play("a", "It is 92 mg/dL.", "Lexi");
    await settle();
    expect(synth.spoken.map((u) => u.text)).toEqual(["It is 92 milligrams per deciliter."]);
  });

  it("falls back to the browser voice for the rest of playback when synthesis fails", async () => {
    failSynthesis = true;
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    expect(synth.spoken.map((u) => u.text.split(" ")[0])).toEqual(["One"]);
    synth.finish();
    expect(synth.spoken.map((u) => u.text.split(" ")[0])).toEqual(["One", "Two"]);
    expect(FakeAudio.played).toHaveLength(0);
  });

  it("falls back when the browser refuses to play the audio", async () => {
    FakeAudio.refusePlay = true;
    speechRegistry.play("a", "hello", "Lexi");
    await settle();
    expect(synth.spoken.map((u) => u.text)).toEqual(["hello"]);
    expect(speechRegistry.statusOf("a")).toBe("playing");
  });

  it("a clip that arrives after pause is not played, and resume replays the paused chunk", async () => {
    speechRegistry.play("a", LONG, "Lexi");
    speechRegistry.pause();
    await settle();
    expect(FakeAudio.played).toHaveLength(0);
    speechRegistry.resume();
    await settle();
    expect(FakeAudio.played).toHaveLength(1);
    expect(synthesized.filter((s) => s.text.startsWith("One"))).toHaveLength(1);
  });

  it("resume continues the same clip a second back, without re-synthesizing it", async () => {
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    const a = FakeAudio.played[0];
    a.currentTime = 5;
    speechRegistry.pause();
    speechRegistry.resume();
    await settle();
    expect(FakeAudio.played).toEqual([a, a]);
    expect(a.paused).toBe(false);
    expect(a.currentTime).toBe(4);
    expect(synthesized.filter((s) => s.text.startsWith("One"))).toHaveLength(1);
  });

  it("a resumed clip still advances to the next chunk when it ends", async () => {
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    speechRegistry.pause();
    speechRegistry.resume();
    await settle();
    FakeAudio.played[0].onended!();
    await settle();
    expect(FakeAudio.played.at(-1)).not.toBe(FakeAudio.played[0]);
    expect(speechRegistry.current().index).toBe(1);
  });

  it("stop after a pause discards the clip, so the next play starts from the top", async () => {
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    FakeAudio.played[0].currentTime = 5;
    speechRegistry.pause();
    speechRegistry.stop();
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    expect(FakeAudio.played.at(-1)).not.toBe(FakeAudio.played[0]);
    expect(FakeAudio.played.at(-1)!.currentTime).toBe(0);
  });

  it("pausing stops the audio element", async () => {
    speechRegistry.play("a", LONG, "Lexi");
    await settle();
    speechRegistry.pause();
    expect(FakeAudio.played[0].paused).toBe(true);
  });
});
