<script lang="ts">
  // W18 — the report Introduction, moved out of the report into an app-level "About" overlay.
  //
  // W70 — hosted in the shared Modal. The comment above used to end "the app has no dialog component
  // of its own", which had stopped being true: this file carried a second, independent copy of the
  // overlay, and so a second copy of every defect — no focus trap, no focus restore, and a
  // `<svelte:window onkeydown>` Escape that fired for every mounted overlay at once. It was the 16th
  // modal surface and the one that proved fixing them twice is how they drift.
  import type { GeneratedBy } from "./types";
  import Modal from "@tinytars/frame/Modal.svelte";
  interface Props {
    onClose: () => void;
    translationModel?: GeneratedBy | null;
  }
  let { onClose, translationModel = null }: Props = $props();

</script>

<Modal label="About this system" {onClose}>
  <div class="about-body">
    <h2>About this system</h2>
    {#if translationModel}
      <p class="about-model">This translation: {translationModel.mode === "dev" ? "DRAFT · DEV" : "PROD"} · {translationModel.model}</p>
    {/if}
    <p>This is a decision-support system that analyzes one patient's laboratory and body-marker data over time. It reasons with an artificial-intelligence model over the patient's own inputs — their profile, stated objective, pursued studies, diagnosed disease, treatment history, and every marker reading on file — and is meant to be read alongside, not in place of, a physician. The approach is the same for every patient: assemble the full data picture, reason across it for the patterns that matter, and surface them for a doctor conversation.</p>
    <h3>How it is Medical Pattern</h3>
    <p>The methodology works by medical pattern-recognition. It matches marker clusters, symptom-to-lab concordances, and treatment responses against established disease processes and physiologic mechanisms — the way an experienced provider recognises a familiar picture. Where the data lines up with a known pattern, the system names that pattern and ties it to the specific readings behind it.</p>
    <h3>How it is Anti-Pattern</h3>
    <p>The methodology also looks for anti-patterns — places where the data breaks the expected picture, or where a line of reasoning risks a known pitfall. Markers that should move together but don't, a treatment whose response contradicts expectation, or a conclusion drawn before the timeline supports it are flagged rather than smoothed over. Holding both the pattern and the anti-pattern in view is what keeps the analysis honest about what the data does and does not yet show.</p>
  </div>
</Modal>

<style>
  /* Only the CONTENT styling remains — the backdrop, panel, close button and mobile padding all live
     in Modal.svelte now. This block used to duplicate them, and its own comment admitted as much
     ("this overlay duplicates that component's CSS rather than reusing it"). */
  .about-body h2 { margin-top: 0; }
  .about-body h3 { margin: 1.25rem 0 0.35rem; font-size: 1rem; }
  .about-body p { line-height: 1.5; margin: 0 0 0.75rem; }
  .about-model { color: var(--muted); font-size: 0.85rem; }
</style>
