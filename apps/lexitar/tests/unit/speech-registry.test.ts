/**
 * @vitest-environment jsdom
 */
// W76 — the read-aloud registry's own header states a property and nothing tested it: `speakingId`
// flipped only at the two call sites would go stale the instant an utterance ends on its own, so
// `onend`/`onerror` are what keep it true. That is exactly the case an e2e cannot reach — the OS
// speech engine finishes when it finishes, and the only evidence is a Stop button that never turns
// back into a Play button.
//
// The fake engine below models the one timing rule the module depends on: cancel()'s `end` event
// arrives as a separate task, not inside the cancel() call. A synchronous fake makes the toggle
// branch unreachable — the second click would re-speak instead of stopping — which is what the test
// "toggles off" pins.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { speechRegistry, isSpeechSupported } from "@tinytars/frame/speech-registry.svelte";

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
      // The `end` event is dispatched as its own task, per the Web Speech spec — never inside the
      // cancel() call. The toggle depends on that: it compares against a speakingId that this
      // cancel has not yet had the chance to clear.
      if (u) queueMicrotask(() => u.onend?.());
    },
    /** The engine finishing on its own — no call site involved. */
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

let synth: ReturnType<typeof fakeSynth>;

beforeEach(() => {
  speechRegistry.stop();
  synth = fakeSynth();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
});

describe("support", () => {
  it("reports unsupported when the engine is absent", () => {
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    expect(isSpeechSupported()).toBe(false);
    speechRegistry.speak("a", "hello");
    expect(speechRegistry.isSpeaking("a")).toBe(false);
  });

  it("reports supported when it is present", () => {
    expect(isSpeechSupported()).toBe(true);
  });
});

describe("speaking", () => {
  it("speaks the text and marks that id as speaking", () => {
    speechRegistry.speak("a", "hello");
    expect(synth.spoken.map((u) => u.text)).toEqual(["hello"]);
    expect(speechRegistry.isSpeaking("a")).toBe(true);
    expect(speechRegistry.isSpeaking("b")).toBe(false);
  });

  it("refuses empty or whitespace-only text without disturbing what is speaking", () => {
    speechRegistry.speak("a", "hello");
    speechRegistry.speak("b", "   ");
    expect(synth.spoken).toHaveLength(1);
    expect(speechRegistry.isSpeaking("a")).toBe(true);
  });

  it("is a singleton: starting one stops the other", () => {
    speechRegistry.speak("a", "hello");
    speechRegistry.speak("b", "goodbye");
    expect(speechRegistry.isSpeaking("a")).toBe(false);
    expect(speechRegistry.isSpeaking("b")).toBe(true);
    expect(synth.spoken.map((u) => u.text)).toEqual(["hello", "goodbye"]);
  });

  it("toggles off when the same id is asked again, and speaks nothing new", () => {
    speechRegistry.speak("a", "hello");
    speechRegistry.speak("a", "hello");
    expect(speechRegistry.isSpeaking("a")).toBe(false);
    expect(synth.spoken).toHaveLength(1);
    expect(synth.cancels).toBe(2);
  });

  it("can be started again after a toggle-off", async () => {
    speechRegistry.speak("a", "hello");
    speechRegistry.speak("a", "hello");
    await Promise.resolve();
    speechRegistry.speak("a", "hello");
    expect(speechRegistry.isSpeaking("a")).toBe(true);
    expect(synth.spoken).toHaveLength(2);
  });
});

describe("the engine finishing on its own", () => {
  it("clears the speaking id when the utterance ends by itself", () => {
    speechRegistry.speak("a", "hello");
    synth.finish();
    expect(speechRegistry.isSpeaking("a")).toBe(false);
  });

  it("clears it when the utterance errors", () => {
    speechRegistry.speak("a", "hello");
    synth.fail();
    expect(speechRegistry.isSpeaking("a")).toBe(false);
  });

  it("a late onend from a superseded utterance does not clear the one now speaking", async () => {
    speechRegistry.speak("a", "hello");
    const first = synth.spoken[0];
    speechRegistry.speak("b", "goodbye");
    first.onend?.();
    await Promise.resolve();
    expect(speechRegistry.isSpeaking("b")).toBe(true);
  });
});

describe("stop", () => {
  it("cancels the engine and clears the flag", () => {
    speechRegistry.speak("a", "hello");
    speechRegistry.stop();
    expect(synth.cancels).toBeGreaterThan(0);
    expect(speechRegistry.isSpeaking("a")).toBe(false);
  });

  it("is harmless with nothing speaking, and with no engine at all", () => {
    speechRegistry.stop();
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    expect(() => speechRegistry.stop()).not.toThrow();
  });
});
