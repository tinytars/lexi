// The optimistic save chain: `saved` / `saveError`, the 2-second confirmation timer, and the promise
// queue that keeps network PUTs from overlapping.
//
// M57 — every section's Add/Edit/Delete persists immediately (no outer Save queuing a whole-client
// draft), so it is normal for a second edit to fire before the first's PUT resolves. The vault update
// is applied OPTIMISTICALLY — synchronously, before the await — so that second edit's own mutation
// handler reads an already-current client instead of a stale one. That is what makes concurrent
// immediate-persists safe without a hand-rolled request queue. The PUTs still serialize here, purely
// so overlapping fetches are never in flight; a PUT's own success or failure never touches the vault
// again (it was already applied), so out-of-order completions cannot roll back newer state.
//
// The write closure is passed per push rather than injected once: the vault, its key and its R2 id are
// the host's, and each queued write must carry the snapshot it was made for.

import { VaultConflictError } from "@tinytars/vault/vault-sink";
import { reportCaughtError } from "./error-reporter";

export interface VaultSave {
  /** True for 2 seconds after a successful write — the "✓ saved" flash. */
  readonly saved: boolean;
  readonly error: string | null;
  /** True while a failed write is still unresolved — i.e. `retry()` would do something. */
  readonly canRetry: boolean;
  /**
   * Why the last push resolved false — INCLUDING a refusal, which `error` deliberately does not latch.
   *
   * `error` drives the banner and arms `retry()`, so a conflict must not set it: the sink's dialog owns
   * that condition and a replayed write can only be refused again. But a caller that AWAITS a push is
   * a caller that cannot proceed without it, and `false` alone tells it nothing it can pass on to the
   * person who hit it. This is that reason, for the caller to raise — never rendered, never retried.
   */
  readonly lastFailure: string | null;
  /**
   * Queue a write. The caller has already applied the change optimistically, and passes a closure that
   * captures THAT snapshot — not a shared slot: two edits queued before the first PUT resolves must
   * write their own snapshots in order, the way a per-call closure has always done here.
   *
   * Resolves true once THIS write has landed and false if it failed — never rejects, so a caller that
   * only wants the banner can ignore it. Awaiting it is for a change that something else is only safe
   * to build on once it is durable, such as a content key whose ciphertext has not been uploaded yet.
   */
  push(write: () => Promise<void>): Promise<boolean>;
  /**
   * Re-queue the LATEST write after a failure.
   *
   * Deliberately not the write that failed. Every write serializes the WHOLE vault, so the most recent
   * closure already contains the failed edit's bytes plus everything since; replaying the failed one
   * would resurrect a superseded snapshot and silently undo later edits — turning a retry button into
   * a second data-loss bug. No-op when there is nothing to retry.
   */
  retry(): void;
}

const SAVED_FLASH_MS = 2000;

export function createVaultSave(report: (err: Error) => void = reportCaughtError): VaultSave {
  let saved = $state(false);
  let error = $state<string | null>(null);
  // Not $state: read only by an awaiting caller, immediately after its own push resolves. Making it
  // reactive would re-run every effect that touches a save on each queued write, for a value no
  // template reads.
  let lastFailure: string | null = null;

  // Not $state: the chain is scheduling machinery, and making it reactive would re-run every effect
  // that touches a save on each queued write.
  let chain: Promise<void> = Promise.resolve();
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  // The most recent write closure, for retry(). Not $state: read only inside retry().
  let lastWrite: (() => Promise<void>) | null = null;

  return {
    get saved() {
      return saved;
    },
    get error() {
      return error;
    },
    get canRetry() {
      return error !== null && lastWrite !== null;
    },
    get lastFailure() {
      return lastFailure;
    },
    push(write) {
      // W70 — do NOT clear the error here. It used to be cleared at the top of every push, so a failed
      // save's only evidence was erased by the very next edit: the row was already gone from the UI
      // (writes are optimistic), the PUT had failed, and nothing anywhere said so. The error now
      // survives until a write actually SUCCEEDS — which is sound precisely because writes are
      // whole-vault, so a later success genuinely carries the failed edit's bytes.
      lastWrite = write;
      const landed = chain
        .then(write)
        .then(() => {
          error = null; // cleared by success, not by the next attempt
          lastFailure = null;
          saved = true;
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => {
            saved = false;
          }, SAVED_FLASH_MS);
          return true;
        })
        .catch((e) => {
          // A REFUSED write is not a failed one, and the two must not share this branch. The sink
          // throws a typed conflict when the blob moved under us, and its conflict hook has already
          // put App's blocking resolve-or-discard dialog on screen — the only thing that can clear
          // the condition, since only the patient can say which side wins.
          //
          // Latching it here did two wrong things. It filed an expected outcome with the error
          // reporter, one issue per concurrent-edit event. And it armed the sidebar's
          // "save failed — retry ↻", which replays the newest closure against an UNCHANGED version
          // token: it can only be refused again — and once the patient has resolved by discarding
          // this tab's edits, that closure still holds exactly the snapshot they discarded, so the
          // retry writes it back over the version they chose to keep.
          //
          // The reason is recorded either way, on `lastFailure` rather than `error`: a caller awaiting
          // durability has to be able to say WHAT stopped it. Before this, a refused content-key save
          // surfaced to the patient as "the content key could not be saved" — naming neither the cause
          // nor the remedy, while the cause was on screen in the dialog behind it.
          lastFailure = (e as Error).message;
          if (e instanceof VaultConflictError) return false;
          error = lastFailure;
          // Writes are optimistic, so the UI already shows the edit as applied: to the user a failed
          // PUT looks like a success until the data is missing on some later load. The banner is the
          // only live signal and it is easy to miss, so file it rather than rely on being told.
          const failure = new Error(error);
          failure.name = "VaultSaveFailed";
          report(failure);
          return false;
        });
      chain = landed.then(() => undefined);
      return landed;
    },
    retry() {
      if (error === null || lastWrite === null) return;
      void this.push(lastWrite);
    },
  };
}
