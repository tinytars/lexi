<script module lang="ts">
  export interface OnboardingNumberField {
    key: string;
    kind: "number";
    label: string;
    placeholder?: string;
    min?: number;
    max?: number;
    invalidMessage?: string;
  }
  export interface OnboardingSelectField {
    key: string;
    kind: "select";
    label: string;
    options: { value: string; label: string }[];
  }
  export type OnboardingField = OnboardingNumberField | OnboardingSelectField;
</script>

<script lang="ts">
  // W46/W47 — first-run screen for a signed-in account with zero records. The field catalog
  // (what to ask, and each field's own validity rule) is entirely caller-supplied — a number field
  // is optional and omitted from the create payload when left blank or when the user skips; a
  // select field always has a value and is always included. Everything the caller collects is
  // stored wherever it wants (LexiTar puts it in the encrypted vault, never the server).
  let {
    productName,
    subheading = "Welcome. A couple of details help tailor your results — or skip and add them later.",
    fields, defaults, onCreate, onSignOut,
    continueLabel = "Continue", busyLabel = "Setting up…", skipLabel = "Skip for now", signOutLabel = "Sign out",
  }: {
    productName: string;
    subheading?: string;
    fields: OnboardingField[];
    defaults: Record<string, unknown>;
    onCreate: (info: Record<string, unknown>) => Promise<void>;
    onSignOut: () => void;
    continueLabel?: string;
    busyLabel?: string;
    skipLabel?: string;
    signOutLabel?: string;
  } = $props();

  let values = $state<Record<string, any>>({ ...defaults });
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function create(withProfile: boolean) {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.kind === "number") {
        if (!withProfile) continue; // optional fields are omitted entirely on Skip
        const raw = values[f.key] as number | null | undefined;
        if (raw == null) continue; // left blank — omit rather than send an invalid value
        if (!Number.isInteger(raw) || (f.min != null && raw < f.min) || (f.max != null && raw > f.max)) {
          error = f.invalidMessage ?? `Enter a valid ${f.label.toLowerCase()}.`;
          return;
        }
        payload[f.key] = raw;
      } else {
        payload[f.key] = values[f.key];
      }
    }
    busy = true; error = null;
    try {
      await onCreate(payload);
      // On success the caller re-renders away from this screen.
    } catch (err) {
      error = (err as Error).message ?? "Could not create the record.";
      busy = false;
    }
  }
</script>

<main class="onboard">
  <h1>{productName}</h1>
  <p class="sub">{subheading}</p>
  <form onsubmit={(e) => { e.preventDefault(); create(true); }}>
    <div class="row">
      {#each fields as f (f.key)}
        <label>{f.label}
          {#if f.kind === "number"}
            <input type="number" inputmode="numeric" min={f.min} max={f.max} placeholder={f.placeholder} bind:value={values[f.key]} />
          {:else}
            <select bind:value={values[f.key]}>
              {#each f.options as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          {/if}
        </label>
      {/each}
    </div>
    <button type="submit" class="primary" disabled={busy}>{busy ? busyLabel : continueLabel}</button>
    {#if error}<p class="err">{error}</p>{/if}
  </form>
  <button class="link" onclick={() => create(false)} disabled={busy}>{skipLabel}</button>
  <button class="link" onclick={onSignOut}>{signOutLabel}</button>
</main>

<style>
  .onboard { max-width: 380px; margin: 12vh auto 0; text-align: center; padding: 0 1rem; }
  .sub { color: var(--muted, #667); margin: 0.25rem 0 1.5rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; text-align: left; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--muted, #667); }
  input, select {
    padding: 0.5rem; font-size: 1rem; border: 1px solid var(--border, #ccc);
    border-radius: 6px; background: var(--bg, #fff); color: var(--fg, #111);
  }
  .row { display: flex; gap: 0.75rem; }
  .row label { flex: 1; }
  .primary {
    margin-top: 0.5rem; padding: 0.6rem; font-size: 1rem; font-weight: 600;
    border: none; border-radius: 6px; background: var(--accent, #2b6aa8); color: var(--surface, #fff); cursor: pointer;
  }
  .primary:disabled { opacity: 0.6; cursor: default; }
  .err { color: var(--alert); font-size: 0.85rem; margin: 0.25rem 0 0; }
  .link {
    margin-top: 1.5rem; background: none; border: none; color: var(--muted, #667);
    text-decoration: underline; cursor: pointer; font-size: 0.85rem;
  }
</style>
