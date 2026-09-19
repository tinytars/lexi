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

// W84 — Lexi's answer restated by `persona`, or null when it should be shown as Lexi's own: Lexi was
// chosen, the adapter could not keep every fact, or the call failed. Never throws; the answer stands.
export async function adaptAnswer(persona: PersonaId, text: string): Promise<{ persona: PersonaId; text: string } | null> {
  if (persona === DEFAULT_PERSONA) return null;
  try {
    const res = await fetch("/api/persona-adapt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona, text }) });
    if (!res.ok) return null;
    const body = (await res.json()) as { kind?: string; persona?: unknown; text?: unknown };
    return body.kind === "adapted" && isPersonaId(body.persona) && typeof body.text === "string" ? { persona: body.persona, text: body.text } : null;
  } catch {
    return null;
  }
}
