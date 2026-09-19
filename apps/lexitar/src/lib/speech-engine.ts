import type { SpeechEngine } from "@tinytars/frame/speech-registry.svelte";
import { speechText } from "./speech-text";

// W84 — read-aloud through /api/speak's neural voices. `voice` is a persona id; any failure throws,
// and the frame's player falls back to the browser voice for the rest of that playback.
export const neuralSpeech: SpeechEngine = {
  async synthesize(text, voice) {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error(`speak ${res.status}`);
    return res.blob();
  },
  normalize: speechText,
};
