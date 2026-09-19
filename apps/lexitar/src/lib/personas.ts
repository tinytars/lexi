// W84 — who answers. Lexi is the brain: every inference is generated in her voice. Kodi is an adapter
// that restates Lexi's finished answer (persona-adapter-prompt.ts); he never reasons over the record.
export type PersonaId = "lexi" | "kodi";

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
  kodi: {
    id: "kodi",
    name: "Kodi",
    blurb: "NYC cycling instructor. Same knowledge, told like your best friend at 4am over fries.",
    voice: "en-US-AndrewMultilingualNeural",
    sample: "Hey, I'm Kodi. Same facts as Lexi, just told the way I'd tell you over fries at four in the morning.",
  },
};

export const DEFAULT_PERSONA: PersonaId = "lexi";

export function isPersonaId(v: unknown): v is PersonaId {
  return typeof v === "string" && Object.hasOwn(PERSONAS, v);
}
