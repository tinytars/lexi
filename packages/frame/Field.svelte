<script lang="ts">
  import type { Snippet } from "svelte";

  // Replaces the ".field" label+span wrapper hoisted across a caller's own Add/Edit modals.
  // `wide` fills its own grid row (`.field--wide`); `span` spans the whole grid (`.field--span`) —
  // the two collided under one shared name for one caller and stay distinct props here for the
  // same reason.
  //
  // Styled with :global() rather than Svelte's normal component-scoped CSS: a caller may also
  // render a bare `class="field"` span directly in its own templates (a read-only display column
  // reusing the same layout, not a labeled input) rather than through this component, and still
  // need the identical base rules.
  interface Props {
    label: string;
    wide?: boolean;
    span?: boolean;
    children: Snippet;
  }
  let { label, wide = false, span = false, children }: Props = $props();
</script>

<label class="field" class:field--wide={wide} class:field--span={span}>
  <span>{label}</span>
  {@render children()}
</label>

<style>
  :global(.field) { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
  :global(.field--wide) { width: 100%; }
  :global(.field--span) { grid-column: 1 / -1; }
  /* Uppercase caption above a field. Excludes a caller's own permalink-heading inner span so a
     read-only .field usage doesn't uppercase-transform the actual value it wraps there. */
  :global(.field > span:not(.permalink-heading)) {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600;
  }
</style>
