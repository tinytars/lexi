<script lang="ts">
  import type { Client } from "./types";
  import { PREGNANCY_VALUES, ATHLETIC_VALUES, SMOKING_VALUES } from "@pablotech/akesi/factors-edit";
  import { foldLegacyTreatments, dropLegacyTreatmentFields } from "./treatment-legacy-fold";
  import { createDraftSync, createPersistNow } from "./draft-sync.svelte";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import Field from "@tinytars/frame/Field.svelte";
  import FormGrid from "@tinytars/frame/FormGrid.svelte";
  import SaveStatus from "@tinytars/frame/SaveStatus.svelte";

  // W35 — the folded-in profile editor; W37 moved it to the first Patient subsection (Profile), now
  // patient-visible + editable. M57 — every field persists immediately (on blur/change) through the
  // shell's saveEdits → saveVault path; there's no outer Save anymore. M65 folded the former
  // Correlations block's legacy data into noteEntries and retired it. M94 — Conditions extracted
  // out to its own top-level leaf (Symptoms.svelte); this component now holds only basic details.
  interface Props {
    client: Client;
    onSave?: (updated: Client) => void; // optional: ReportSections passes it through as optional
    saved?: boolean;
    saveError?: string | null;
  }
  let {
    client, onSave, saved = false, saveError = null,
  }: Props = $props();

  // draft is the scratch buffer a field's keystrokes land in before its own persist point
  // (blur/change); createDraftSync resyncs it from the live client only when its identity
  // genuinely changes (patient switch / import), suppressing the resync for our own
  // immediate-persist's echo so it doesn't clobber another field's in-progress-but-not-yet-blurred
  // edit. Ensure the authored collections exist so the form can bind/add freely; normalizeClientDraft
  // strips any that stay empty back to absent on save. Folds a possibly-legacy vault into the
  // unified list.
  function build(c: Client): Client {
    const d = structuredClone($state.snapshot(c)) as Client;
    d.factors ??= {};
    d.factors.diseases ??= [];
    dropLegacyTreatmentFields(foldLegacyTreatments(d));
    d.factors.decisions ??= [];
    d.study ??= {};
    d.study.entries ??= [];
    d.recommended ??= [];
    return d;
  }

  const ds = createDraftSync(() => client, build, () => saveError);
  const draft = $derived(ds.draft);

  const persistNow = createPersistNow(ds, () => client, onSave, undefined);
</script>

<div class="personalization leaf-section">
  <div class="pz-editbar">
    <div class="pz-title">
      <SaveStatus {saved} />
    </div>
  </div>
  <SaveStatus error={saveError} />

  <section class="pz-block">
    <FormGrid>
      <Field label="Display name" span>
        <div class="field-row">
          <input type="text" bind:value={draft.displayName} onblur={() => persistNow((p) => (p.displayName = draft.displayName))} />
          <DictateButton onResult={(t) => {
            draft.displayName = draft.displayName ? `${draft.displayName} ${t}` : t;
            persistNow((p) => (p.displayName = draft.displayName));
          }} />
        </div>
      </Field>
      <Field label="Date of birth">
        <input type="text" placeholder="YYYY-MM-DD" bind:value={draft.dob} onblur={() => persistNow((p) => (p.dob = draft.dob))} />
      </Field>
      <Field label="Gender">
        <select bind:value={draft.gender} onchange={() => persistNow((p) => (p.gender = draft.gender))}>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </Field>
      <Field label="Height">
        <input type="text" placeholder="e.g. 176cm" bind:value={draft.factors!.height} onblur={() => persistNow((p) => (p.factors!.height = draft.factors!.height))} />
      </Field>
      <Field label="BMI">
        <input type="number" step="0.1" bind:value={draft.factors!.bmi} onblur={() => persistNow((p) => (p.factors!.bmi = draft.factors!.bmi))} />
      </Field>
      <Field label="Ethnicity">
        <input type="text" bind:value={draft.factors!.ethnicity} onblur={() => persistNow((p) => (p.factors!.ethnicity = draft.factors!.ethnicity))} />
      </Field>
      <Field label="Pregnancy">
        <select bind:value={draft.factors!.pregnancy} onchange={() => persistNow((p) => (p.factors!.pregnancy = draft.factors!.pregnancy))}>
          <option value={undefined}>—</option>
          {#each PREGNANCY_VALUES as v}<option value={v}>{v}</option>{/each}
        </select>
      </Field>
      <Field label="Activity">
        <select bind:value={draft.factors!.athletic} onchange={() => persistNow((p) => (p.factors!.athletic = draft.factors!.athletic))}>
          <option value={undefined}>—</option>
          {#each ATHLETIC_VALUES as v}<option value={v}>{v}</option>{/each}
        </select>
      </Field>
      <Field label="Smoking">
        <select bind:value={draft.factors!.smoking} onchange={() => persistNow((p) => (p.factors!.smoking = draft.factors!.smoking))}>
          <option value={undefined}>—</option>
          {#each SMOKING_VALUES as v}<option value={v}>{v}</option>{/each}
        </select>
      </Field>
      <Field label="Goal" span>
        <div class="field-row">
          <textarea rows="3" bind:value={draft.factors!.goal} onblur={() => persistNow((p) => (p.factors!.goal = draft.factors!.goal))}></textarea>
          <DictateButton onResult={(t) => {
            draft.factors!.goal = draft.factors!.goal ? `${draft.factors!.goal} ${t}` : t;
            persistNow((p) => (p.factors!.goal = draft.factors!.goal));
          }} />
        </div>
      </Field>
      <Field label="Focus" span>
        <div class="field-row">
          <textarea rows="3" bind:value={draft.factors!.focus} onblur={() => persistNow((p) => (p.factors!.focus = draft.factors!.focus))}></textarea>
          <DictateButton onResult={(t) => {
            draft.factors!.focus = draft.factors!.focus ? `${draft.factors!.focus} ${t}` : t;
            persistNow((p) => (p.factors!.focus = draft.factors!.focus));
          }} />
        </div>
      </Field>
    </FormGrid>
  </section>
</div>

<style>
  input, select, textarea {
    font: inherit; font-size: 0.95rem; color: var(--fg);
    padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: white; width: 100%; box-sizing: border-box;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--band); }
  textarea { resize: vertical; line-height: 1.5; min-height: 3.2rem; }

  @media print { .personalization { display: none !important; } }
</style>
