import { DEFAULT_PERSONA, readPersonaId, type PersonaId } from "./personas";

// A missing or unreadable preference is the default persona, never an error: the voice is cosmetic
// next to everything else a login loads.
export async function loadPersona(): Promise<PersonaId> {
  try {
    const res = await fetch("/api/account/persona");
    const body = res.ok ? ((await res.json()) as { persona?: unknown }) : {};
    return readPersonaId(body.persona) ?? DEFAULT_PERSONA;
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
// `question` is what the patient asked, so the persona can show it was heard.
export async function adaptAnswer(persona: PersonaId, text: string, question?: string): Promise<{ persona: PersonaId; text: string } | null> {
  if (persona === DEFAULT_PERSONA) return null;
  try {
    const res = await fetch("/api/persona-adapt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona, text, question }) });
    if (!res.ok) return null;
    const body = (await res.json()) as { kind?: string; persona?: unknown; text?: unknown };
    const adapted = readPersonaId(body.persona);
    return body.kind === "adapted" && adapted && typeof body.text === "string" ? { persona: adapted, text: body.text } : null;
  } catch {
    return null;
  }
}

// W84 — "Cody's take" on any assistant bubble, cached per text for the session so reopening a take is
// instant. A failed take is dropped from the cache so it can be retried.
const takes = new Map<string, Promise<string | null>>();

export function personaTake(persona: PersonaId, text: string): Promise<string | null> {
  const key = `${persona}:${text}`;
  let take = takes.get(key);
  if (!take) {
    take = adaptAnswer(persona, text).then((a) => a?.text ?? null);
    takes.set(key, take);
    void take.then((t) => { if (t === null) takes.delete(key); });
  }
  return take;
}
