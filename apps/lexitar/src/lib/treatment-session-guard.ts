// Extracted from UnifiedTreatment.svelte's attachToTreatment and togglePinTreatment (W79 phase 4a) —
// both had the byte-identical guard `!client.factors?.treatments?.some((x) => x.id === t.id)) return;`
// before calling persistNow. A row added this session has no server copy yet, so there is nothing to
// persist a mutation onto — the in-memory draft edit is enough until the row itself is saved.

import type { Client } from "./types";

export function wasSavedThisSession(client: Client, id: string): boolean {
  return client.factors?.treatments?.some((x) => x.id === id) ?? false;
}
