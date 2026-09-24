// The browser's /api/corpus-warm caller.

import type { UnitSystem } from "./units";

// Whether this deployment attaches reports, learned from the warm call the app makes when a record
// is opened. It decides whether an attached PDF still needs its transcription sent as text, so the
// safe default before the first answer is FALSE — keep sending it, exactly as before this feature.
let corpusAttached = false;

// Which `reason` answers are a verdict on the DEPLOYMENT rather than on this one attempt. "off" is
// the only one that means the documents are not in the request; "unsupported" (this provider has no
// pre-warm) and "no_corpus" (this record holds no PDFs yet) both mean the corpus path is live.
//
// W86 — the route answers 200 for a failure too, so a busy provider is not a red request in the
// console for an outcome a pre-warm is built to tolerate. That answer says nothing about whether
// the documents will be attached, so it must leave this belief alone: reading it as "attached"
// drops the transcription from the question while nothing is carrying the document at all.
const VERDICTS = new Set(["off", "unsupported", "no_corpus"]);

/** Whether the model will see attached PDFs as documents, so their transcription is redundant. */
export function reportsAreAttached(): boolean {
  return corpusAttached;
}

/**
 * Reads the record's reports into the prompt cache so the patient's first question does not wait on
 * a ~270K-token cache write. Resolves whether or not anything was warmed — the server declines for
 * a record with no PDFs, a deployment with REPORTS off, or a provider without prompt caching, and
 * none of those is a condition a patient should hear about.
 */
export async function warmCorpus(clientId: string, unitSystem: UnitSystem): Promise<boolean> {
  const res = await fetch("/api/corpus-warm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, unitSystem }),
  });
  if (!res.ok) return false;
  const payload = (await res.json().catch(() => null)) as { warmed?: boolean; reason?: string } | null;
  if (payload?.warmed === true) corpusAttached = true;
  else if (payload && VERDICTS.has(payload.reason ?? "")) corpusAttached = payload.reason !== "off";
  return payload?.warmed === true;
}
