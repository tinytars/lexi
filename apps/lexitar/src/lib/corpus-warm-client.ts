// The browser's /api/corpus-warm caller.

import type { UnitSystem } from "./units";

// Whether this deployment attaches reports, learned from the warm call the app makes when a record
// is opened. It decides whether an attached PDF still needs its transcription sent as text, so the
// safe default before the first answer is FALSE — keep sending it, exactly as before this feature.
let corpusAttached = false;

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
  // "off" is the only answer that means the documents are NOT in the request. "unsupported" means
  // this provider has no pre-warm, not that it has no corpus.
  if (payload) corpusAttached = payload.reason !== "off";
  return payload?.warmed === true;
}
