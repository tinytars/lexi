// One entry's Translate: the pending id, the error, and the call.
//
// Four leaf editors (Notes, Study, Allergies, Family) carried byte-identical copies of this —
// including the five-line comment above it — differing only in the node key and what they pass as
// the target. They are the same operation on the same contract, so they share one implementation.
//
// NOT extracted: UnifiedTreatment, HypothesisTopicCard and MarkerChart also translate, but each
// tracks a per-item `translateErrorId` so the message can sit next to the row that failed rather
// than above the section. That is a real difference in what the user sees, and draft-sync.svelte.ts's
// own header records the finding that these editors have per-entity divergence which "doesn't safely
// generalize" — folding three different error placements behind one flag is what that warns against.
import { describeAiError } from "./ai-error";

// The shape every leaf editor already declares for this prop.
type TriggerRegen = (
  key: string,
  targetLabels?: string[],
  force?: boolean,
) => Promise<{ status: "filled" | "empty" | "skipped" | "failed"; error?: string }>;

export interface LeafTranslate {
  readonly translatingId: string | null;
  readonly translateError: string | null;
  /** `force` bypasses the staleness gate so the click always fires — see App.svelte's regenNode. */
  run(id: string, node: string, targets: string[]): Promise<void>;
}

export function createLeafTranslate(getTrigger: () => TriggerRegen | undefined): LeafTranslate {
  let translatingId = $state<string | null>(null);
  let translateError = $state<string | null>(null);

  return {
    get translatingId() { return translatingId; },
    get translateError() { return translateError; },
    async run(id, node, targets) {
      translatingId = id;
      translateError = null;
      try {
        const r = await getTrigger()?.(node, targets, true);
        if (r?.status === "failed") translateError = r.error ?? "Couldn't translate.";
        else if (r?.status === "empty") translateError = "Nothing to translate yet.";
      } catch (e) {
        // describeAiError, not the raw message: ai-error.ts maps a known code to a patient-facing
        // sentence and refuses to render a leaked JSON body ("never show it to a patient").
        translateError = describeAiError(e);
      } finally {
        translatingId = null;
      }
    },
  };
}
