// The browser's /api/corpus-warm caller.

import type { UnitSystem } from "./units";

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
  const payload = (await res.json().catch(() => null)) as { warmed?: boolean } | null;
  return payload?.warmed === true;
}
