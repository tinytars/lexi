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
//
// No record selected → no restatement, for the same never-throw reason: the route now answers in
// sight of that record's reports (CORPUS.md) and refuses without one, and a missing voice is a far
// smaller thing than an error where an answer should be.
export async function adaptAnswer(
  persona: PersonaId,
  clientId: string | null,
  text: string,
  question?: string,
): Promise<{ persona: PersonaId; text: string } | null> {
  if (persona === DEFAULT_PERSONA || !clientId) return null;
  try {
    const res = await fetch("/api/persona-adapt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona, clientId, text, question }) });
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

export function personaTake(persona: PersonaId, clientId: string | null, text: string): Promise<string | null> {
  // The record is part of the key: the same sentence restated against a different record is a
  // different take, and a cache that ignored that would serve one patient's from another's.
  const key = `${persona}:${clientId ?? ""}:${text}`;
  let take = takes.get(key);
  if (!take) {
    take = adaptAnswer(persona, clientId, text).then((a) => a?.text ?? null);
    takes.set(key, take);
    void take.then((t) => { if (t === null) takes.delete(key); });
  }
  return take;
}
