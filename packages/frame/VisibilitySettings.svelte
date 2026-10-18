<script module lang="ts">
  export interface VisibilityFeature {
    key: string;
    label: string;
  }
</script>

<script lang="ts">
  // Generic panel to configure what a subject's own session sees. Each feature toggles
  // between subject-visible and viewer-only; the catalog, current-visibility check, and save are
  // all injected, so this component knows nothing about clients, patients, or providers.
  let {
    subjectLabel, features, isVisible, onSave, viewerLabel = "You",
  }: {
    subjectLabel: string;
    features: VisibilityFeature[];
    isVisible: (key: string) => boolean;
    onSave: (key: string, visible: boolean) => Promise<void>;
    viewerLabel?: string;
  } = $props();

  let busyKey = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function set(key: string, visible: boolean) {
    error = null;
    busyKey = key;
    try {
      await onSave(key, visible);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyKey = null;
    }
  }
</script>

<div class="vis">
  <p class="lead">Choose what <strong>{subjectLabel}</strong> sees when signed in as themselves. {viewerLabel} always see everything.</p>
  {#if error}<p class="vis-error">{error}</p>{/if}

  <ul class="vis-list">
    {#each features as f (f.key)}
      <li>
        <label>
          <input type="checkbox" checked={isVisible(f.key)} disabled={busyKey === f.key} onchange={(e) => set(f.key, e.currentTarget.checked)} />
          <span>{f.label}</span>
        </label>
      </li>
    {/each}
  </ul>
</div>

<style>
  .vis { max-width: 34rem; }
  .lead { color: var(--muted); line-height: 1.5; margin: 0 0 1rem; }
  .vis-list { list-style: none; margin: 0; padding: 0; }
  .vis-list li { padding: 0.15rem 0; }
  .vis-list label { display: flex; align-items: center; gap: 0.55rem; cursor: pointer; }
  .vis-list input { width: 1.05rem; height: 1.05rem; }
  .vis-error { color: var(--alert); font-size: 0.85rem; }
</style>
