// The browser's /api/refresh-range caller.
//
// Every other AI call from the browser already had one of these — leaf-regen-client.ts,
// marker-groups-client.ts, refresh-client.ts, extract-client.ts, treatment-infer-client.ts,
// document-extract-client.ts. Ranges was the lone holdout, hand-rolled inline in App.svelte, which is
// how it ended up the only one whose deadline and error mapping had to be fixed twice.

import { AiError, withDeadline } from "./ai-error";
import { LEAF_REGEN_DEADLINE_MS } from "./leaf-regen-config";
import type { Client, PersonalizedRange } from "./types";
import { corpusSubject } from "./vault-raw-keys";

/**
 * One marker's personalized range. Throws AiError with the relay's machine-readable errorCode so the
 * caller can render the same sentence describeAiError gives every other AI surface — the deadline and
 * the typed error are the whole reason this is not a bare fetch.
 *
 * `clientId` is positional and required rather than an option: the range is generated in sight of
 * that record's own reports (CORPUS.md), so a caller that forgets it is a type error here rather
 * than a 400 in front of a patient.
 */
export async function fetchPersonalizedRange(
  client: Client,
  clientId: string,
  marker: string,
  providerToken: string | null | undefined,
): Promise<PersonalizedRange> {
  const res = await withDeadline(LEAF_REGEN_DEADLINE_MS, (signal) =>
    fetch("/api/refresh-range", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ client, ...corpusSubject(clientId), marker }),
      signal,
    }).catch((e) => {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("couldn't reach the AI service", { errorCode: "offline" });
    }),
  );
  const payload = (await res.json().catch(() => null)) as { range?: PersonalizedRange; error?: string; errorCode?: string } | null;
  if (!res.ok) {
    throw new AiError(payload?.error || `translate failed (${res.status})`, {
      errorCode: payload?.errorCode,
      status: res.status,
    });
  }
  return payload!.range!;
}
