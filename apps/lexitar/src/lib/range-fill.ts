// The post-import range backfill: one personalized range per marker that has none yet.
//
// Extracted from App.svelte (W79 phase 3b took the eligibility half; this takes the sweep) so the
// pacing below is a property that can be tested rather than a line in a component.

import type { Client } from "./types";
import { eligibleMarkersForRangeFill } from "./range-eligibility";

/**
 * ONE MARKER AT A TIME, and the caller puts the whole sweep on the shared corpus lane
 * (src/lib/corpus-lane.ts) so it does not overlap the corpus warmer or the leaf sweep either.
 *
 * Every range call carries the patient's whole report corpus (CORPUS.md), which the Function holding
 * it reserves against its isolate's 128 MB ceiling for as long as the request runs. Two of them on
 * one isolate is what that budget refuses, and the refusal arrives here as a swallowed failure — a
 * marker silently left without a range. Serial also keeps what the old fan-out was written for: a
 * prompt-cache entry is not readable until the first response begins, so simultaneous calls each
 * write their own copy of the same 270K tokens instead of reading one.
 *
 * `fill` owns its own failures: a marker that cannot be filled must not stop the sweep, and
 * MarkerChart's per-marker Translate button is the recovery.
 */
export async function fillMissingRanges(client: Client, fill: (marker: string) => Promise<void>): Promise<void> {
  for (const marker of eligibleMarkersForRangeFill(client)) {
    await fill(marker);
  }
}
