<script lang="ts">
  // Replaces the repeated `{#if saved}<span class="saved">✓ saved</span>{/if}` +
  // `{#if saveError}<p class="save-error">{saveError}</p>{/if}` pair duplicated across every leaf
  // editor. `saved` and `error` render independently, so a file with several unrelated error
  // sources (attach error, translate error, …) can render this once near the checkmark with
  // `saved` + its primary error, then again standalone with just `error` for each additional one.
  // `notice` is for something the caller has to say that is not a failure: the operation succeeded
  // and the result is standing there, but it was produced under a condition the reader would want
  // to know about. Separate from `error` rather than folded into it, because a reader who is told
  // an error has occurred looks for something to retry, and there is nothing to retry here.
  interface Props {
    saved?: boolean;
    error?: string | null;
    notice?: string | null;
  }
  let { saved = false, error = null, notice = null }: Props = $props();
</script>

{#if saved}<span class="saved">✓ saved</span>{/if}
{#if error}<p class="save-error">{error}</p>{/if}
{#if notice}<p class="save-notice">{notice}</p>{/if}

<style>
  .saved { color: var(--accent); font-size: 0.8rem; font-weight: 600; }
  .save-error { color: var(--alert); margin: 0.25rem 0 0.75rem; }
  .save-notice { color: var(--muted); margin: 0.25rem 0 0.75rem; font-size: 0.85rem; }
</style>
