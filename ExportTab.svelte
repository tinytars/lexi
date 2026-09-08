<script module lang="ts">
  export interface ExportOption {
    key: string;
    title: string;
    description: string;
    buttonLabel: string;
    onClick?: () => void; // omitted (with disabled) for a not-yet-available option
    disabled?: boolean;
    badge?: string;
  }
</script>

<script lang="ts">
  // W11e — a generic "take this record out of the app" panel. The list of destinations (what they
  // export, in what format, whether they're live yet) is entirely caller-supplied, so this
  // component carries no knowledge of vaults, markers, or any other domain data shape.
  let {
    title = "Export",
    lead = "Take this record out of the app. Everything here is generated on your device — nothing is sent anywhere.",
    options,
  }: {
    title?: string;
    lead?: string;
    options: ExportOption[];
  } = $props();
</script>

<div class="export-tab">
  <h2>{title}</h2>
  <p class="lead">{lead}</p>

  <ul class="export-options">
    {#each options as opt (opt.key)}
      <li class:soon={opt.disabled}>
        <div class="opt-text">
          <h3>{opt.title}{#if opt.badge}<span class="soon-tag">{opt.badge}</span>{/if}</h3>
          <p>{opt.description}</p>
        </div>
        <button class="primary" disabled={opt.disabled} onclick={opt.onClick}>{opt.buttonLabel}</button>
      </li>
    {/each}
  </ul>
</div>

<style>
  h2 { margin: 0 0 0.4rem; font-size: 1.25rem; }
  .lead { color: var(--muted); margin: 0 0 1.5rem; line-height: 1.5; }
  .export-options { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.75rem; }
  .export-options li {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: white;
  }
  .opt-text { flex: 1; min-width: 0; }
  .opt-text h3 { margin: 0 0 0.25rem; font-size: 1rem; }
  .opt-text p { margin: 0; color: var(--muted); font-size: 0.88rem; line-height: 1.45; }
  .primary {
    flex: 0 0 auto;
    padding: 0.6rem 1rem;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: white;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    min-height: 44px;
    white-space: nowrap;
  }
  .primary:hover { filter: brightness(1.05); }
  .primary:disabled { background: var(--border); border-color: var(--border); color: var(--muted); cursor: default; }
  .soon { opacity: 0.8; }
  .soon-tag {
    font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.4rem; margin-left: 0.4rem; vertical-align: middle;
  }
  @media (max-width: 560px) {
    .export-options li { flex-direction: column; align-items: stretch; }
    .primary { width: 100%; }
  }
  @media print { .export-tab { display: none !important; } }
</style>
