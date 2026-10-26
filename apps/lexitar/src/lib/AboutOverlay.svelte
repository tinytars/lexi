<script lang="ts">
  // W18 — the report Introduction, moved out of the report into an app-level "About" overlay.
  //
  // W70 — hosted in the shared Modal. The comment above used to end "the app has no dialog component
  // of its own", which had stopped being true: this file carried a second, independent copy of the
  // overlay, and so a second copy of every defect — no focus trap, no focus restore, and a
  // `<svelte:window onkeydown>` Escape that fired for every mounted overlay at once. It was the 16th
  // modal surface and the one that proved fixing them twice is how they drift.
  // 2026-10-26 — the opening paragraph called this "a decision-support system that analyzes one
  // patient's ... data". Both halves had to go, and not for tone. `apps/BRANDING.md` in the
  // websites repository is the copy manual for every LexiTar surface: it forbids "decision support"
  // outright, its criterion-2 diagnostic boundary forbids "analyze your" outside a disclaimer, and
  // its §4 lexicon gives the replacements — translate, map, reference, compile. The reason it is
  // forbidden rather than merely off-brand is that the Foundation's Google Ad Grant rests on
  // "education, not medicine": Google for Nonprofits excludes healthcare organizations, this app is
  // where a paid click lands, and a reviewer reads the words on the screen rather than LIABILITY.md.
  // The same sentence is also the FDA Clinical Decision Support guidance's own term of art, which
  // LIABILITY.md argues this tool sits outside of — so the app was describing itself as the one
  // thing its liability analysis says it is not.
  //
  // "patient" and "clinical" are avoided here for that reason too, and only here: both are correct
  // and are kept everywhere they describe the data model (`report-sections.ts`) or quote a
  // regulation (`LIABILITY.md`). What they do on a screen is invite a skimming reviewer to file the
  // Foundation as a hospital, and that is an eligibility matter rather than a style one.
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
    <p>This is a health literacy tool. It compiles your own laboratory and body-marker records into one timeline, translates the terminology into plain language, and maps each reading against a standard demographic reference range, so that what changed and over what period is legible to you. An artificial-intelligence model reads the inputs you have entered — your profile, stated objective, pursued studies, recorded conditions, treatment history, and every marker reading on file — and compiles what it references into something you can take to a doctor and ask about. It is educational: it offers no diagnosis, no triage and no treatment advice, and it is meant to be read alongside a physician rather than in place of one. The approach is the same for everyone: compile the whole record, reference it for the patterns worth asking about, and show the readings behind each one.</p>
    <h3>How to use it</h3>
    <ol class="about-steps">
      <li><strong>Bring your record in.</strong> <em>Import</em>, in the menu at the top right, takes a lab spreadsheet, a device export, or a health report as a PDF — the pane itself says which of those this deployment can read. It pulls the values out and files each one under the marker it belongs to, so nothing is typed in twice. <em>Labs</em> then shows what arrived and the document it came from.</li>
      <li><strong>See what changed.</strong> <em>Labs</em> and the Markers section put every reading on a timeline against a standard demographic reference range adjusted for your details. The Glossary defines any term or abbreviation you have not met before, in plain language.</li>
      <li><strong>Ask in your own words.</strong> <em>Chat</em> answers questions about what is on file — what a marker is, which way it has moved, what is missing — without you having to know the term for it first.</li>
      <li><strong>Walk in prepared.</strong> <em>Appointment</em> compiles the questions worth raising and the terms you will hear, each tied to the readings behind it. Print it and take it with you; the printed page carries the same reminder the app does.</li>
    </ol>
    <p>There is nothing to buy and no tier to join, and the whole point of the output is that you take it to a doctor: it is a list of questions with your own readings attached, not an answer.</p>
    <h3>Pattern</h3>
    <p>The method references patterns. It matches marker clusters, symptom-to-lab concordances and treatment responses against documented physiologic mechanisms. Where your data lines up with a documented pattern, the tool names that pattern and ties it to the specific readings behind it — so the thing you carry into an appointment is a question with the readings attached, not a conclusion.</p>
    <h3>Anti-pattern</h3>
    <p>The method also references anti-patterns — places where the data breaks the expected picture, or where a line of reasoning risks a known pitfall. Markers that should move together but don't, a treatment whose response contradicts expectation, or a conclusion drawn before the timeline supports it are flagged rather than smoothed over. Holding both the pattern and the anti-pattern in view is what keeps the reading honest about what your data does and does not yet show.</p>
  </div>
</Modal>

<style>
  /* Only the CONTENT styling remains — the backdrop, panel, close button and mobile padding all live
     in Modal.svelte now. This block used to duplicate them, and its own comment admitted as much
     ("this overlay duplicates that component's CSS rather than reusing it"). */
  .about-body h2 { margin-top: 0; }
  .about-body h3 { margin: 1.25rem 0 0.35rem; font-size: 1rem; }
  .about-body p { line-height: 1.5; margin: 0 0 0.75rem; }
  .about-steps { line-height: 1.5; margin: 0 0 0.75rem; padding-left: 1.25rem; }
  .about-steps li { margin: 0 0 0.5rem; }
  .about-model { color: var(--muted); font-size: 0.85rem; }
</style>
