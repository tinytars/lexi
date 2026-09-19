/**
 * @vitest-environment jsdom
 */
// The read-aloud player. What an e2e cannot reach: the OS speech engine finishes (or fails) each
// utterance whenever it likes, and cancel()'s `end` event arrives as its own task, after the call
// that caused it. The fake engine below models exactly that, so a stale `end` from a chunk that was
// paused or superseded is delivered the way a real browser delivers it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { speechRegistry, speechChunks, isSpeechSupported } from "@tinytars/frame/speech-registry.svelte";

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  it("keeps short text as one chunk", () => {
    expect(speechChunks("Hello there. How are you?")).toEqual(["Hello there. How are you?"]);
  });

  it("splits at sentence boundaries once a chunk would exceed the limit", () => {
    const s = "A".repeat(150) + ".";
    expect(speechChunks(`${s} ${s} ${s}`)).toEqual([s, s, s]);
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
