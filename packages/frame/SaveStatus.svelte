<script lang="ts">
  // Replaces the repeated `{#if saved}<span class="saved">✓ saved</span>{/if}` +
  // `{#if saveError}<p class="save-error">{saveError}</p>{/if}` pair duplicated across every leaf
  // editor. `saved` and `error` render independently, so a file with several unrelated error
  // sources (attach error, translate error, …) can render this once near the checkmark with
  // `saved` + its primary error, then again standalone with just `error` for each additional one.
  interface Props {
    saved?: boolean;
    error?: string | null;
  }
  let { saved = false, error = null }: Props = $props();
</script>

{#if saved}<span class="saved">✓ saved</span>{/if}
{#if error}<p class="save-error">{error}</p>{/if}

<style>
  .saved { color: var(--accent); font-size: 0.8rem; font-weight: 600; }
  .save-error { color: var(--alert); margin: 0.25rem 0 0.75rem; }
</style>
