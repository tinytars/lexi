// W84 — who answers. Lexi is the brain: every inference is generated in her voice. Kodi is an adapter
// that restates Lexi's finished answer (persona-adapter-prompt.ts); he never reasons over the record.
export type PersonaId = "lexi" | "kodi";

export interface Persona {
  id: PersonaId;
  name: string;
  blurb: string;
  // Neural voice (speak.ts). Fixed per persona so a persona always sounds like the same person.
  voice: string;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  lexi: {
    id: "lexi",
    name: "Lexi",
    blurb: "MD-PhD and astronaut. Reasons to the answer step by step, in crisp executive bullets.",
    voice: "en-US-AvaMultilingualNeural",
  },
  kodi: {
    id: "kodi",
    name: "Kodi",
    blurb: "NYC cycling instructor. Same knowledge, told like your best friend at 4am over fries.",
    voice: "en-US-AndrewMultilingualNeural",
  },
};

export const DEFAULT_PERSONA: PersonaId = "lexi";

export function isPersonaId(v: unknown): v is PersonaId {
  return typeof v === "string" && Object.hasOwn(PERSONAS, v);
}
