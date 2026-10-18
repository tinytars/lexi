// W84 — who answers. Lexi is the brain: every inference is generated in her voice. Cody is an adapter
// that restates Lexi's finished answer (persona-adapter-prompt.ts); he never reasons over the record.
export type PersonaId = "lexi" | "cody";

export interface Persona {
  id: PersonaId;
  name: string;
  blurb: string;
  // Neural voice (speak.ts). Fixed per persona so a persona always sounds like the same person.
  voice: string;
  // A fixed, PHI-free line for the picker's "Hear" button.
  sample: string;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  lexi: {
    id: "lexi",
    name: "Lexi",
    blurb: "MD-PhD and astronaut. Reasons to the answer step by step, in crisp executive bullets.",
    voice: "en-US-AvaMultilingualNeural",
    sample: "Hi, I'm Lexi. I lead with the answer, then give you just enough of the reasoning to trust it.",
  },
  cody: {
    id: "cody",
    name: "Cody",
    blurb: "NYC cycling instructor. Hears what you're really asking, is fully in your corner, and still tells it like it is.",
    voice: "en-US-AndrewMultilingualNeural",
    sample: "Hey, I'm Cody. I'm listening, I'm on your side, and I'll always give it to you straight.",
  },
};

export const DEFAULT_PERSONA: PersonaId = "lexi";

export function isPersonaId(v: unknown): v is PersonaId {
  return typeof v === "string" && Object.hasOwn(PERSONAS, v);
}

// Cody first shipped as "kodi"; account rows, saved chat turns, and still-open tabs may carry that id.
const RENAMED: Record<string, PersonaId> = { kodi: "cody" };

export function readPersonaId(v: unknown): PersonaId | null {
  const id = typeof v === "string" && Object.hasOwn(RENAMED, v) ? RENAMED[v] : v;
  return isPersonaId(id) ? id : null;
}
