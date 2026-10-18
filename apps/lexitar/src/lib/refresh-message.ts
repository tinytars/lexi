// Extracted from App.svelte's doRefresh (W79 phase 3b). Builds the post-refresh status message from
// the two independent outcome lists refreshFindingWithLeaves returns. Deliberately two separate `if`s,
// never `if`/`else if` — see the call site's comment: that was a real bug (an invariant report going
// missing exactly when a leaf had also failed, the run most likely to need it).

import type { LeafFailure } from "./finding-refresh";

export function buildRefreshMessage(failures: LeafFailure[], invariants: string[]): string | null {
  const notes: string[] = [];
  if (failures.length > 0) {
    notes.push(
      `${failures.length} section${failures.length === 1 ? "" : "s"} could not be regenerated: ${failures.map((f) => f.label).join(", ")} — the previous version is still shown, marked out of date. Use ⋮ → Translate on each to retry.`,
    );
  }
  if (invariants.length > 0) {
    notes.push(
      `the assembled Finding has ${invariants.length} inconsistenc${invariants.length === 1 ? "y" : "ies"}: ${invariants[0]}${invariants.length > 1 ? ` (+${invariants.length - 1} more)` : ""}`,
    );
  }
  if (notes.length === 0) return null;
  return `Finished, but ${notes.join(" Also, ")}`;
}
