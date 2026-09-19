import { DEFAULT_PERSONA, isPersonaId, type PersonaId } from "./personas";

// A missing or unreadable preference is the default persona, never an error: the voice is cosmetic
// next to everything else a login loads.
export async function loadPersona(): Promise<PersonaId> {
  try {
    const res = await fetch("/api/account/persona");
    const body = res.ok ? ((await res.json()) as { persona?: unknown }) : {};
    return isPersonaId(body.persona) ? body.persona : DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

export async function savePersona(persona: PersonaId): Promise<void> {
  const res = await fetch("/api/account/persona", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona }) });
  if (!res.ok) throw new Error("could not save your persona");
}
