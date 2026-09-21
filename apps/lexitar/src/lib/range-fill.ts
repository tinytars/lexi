// The post-import range backfill: one personalized range per marker that has none yet.
//
// Extracted from App.svelte (W79 phase 3b took the eligibility half; this takes the sweep) so the
// warm-up below is a property that can be tested rather than a line in a component.

import type { Client } from "./types";
import { runWithConcurrency } from "@tinytars/frame/concurrency";
import { eligibleMarkersForRangeFill } from "./range-eligibility";

export const RANGE_FILL_CONCURRENCY = 4;

/**
 * The first marker runs ALONE; the rest fan out behind it.
 *
 * Every range call carries the patient's whole report corpus (CORPUS.md) and every one of them sends
 * the identical prefix — same system prompt, same documents — so the first response to begin
 * streaming leaves a cache entry the others read at a tenth of the price. A cache entry is not
 * readable until then, so four simultaneous first calls write four copies of the same 270K tokens
 * instead of one. Waiting for one call is the whole saving.
 *
 * `fill` owns its own failures: a marker that cannot be filled must not stop the sweep, and
 * MarkerChart's per-marker Translate button is the recovery.
 */
export async function fillMissingRanges(client: Client, fill: (marker: string) => Promise<void>): Promise<void> {
  const [first, ...rest] = eligibleMarkersForRangeFill(client);
  if (first === undefined) return;
  await fill(first);
  await runWithConcurrency(rest, RANGE_FILL_CONCURRENCY, fill);
}
