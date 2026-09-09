<script lang="ts">
  import type { Snippet } from "svelte";

  // Replaces the ".field" label+span wrapper hoisted across every leaf editor's Add/Edit modal.
  // `wide` fills its own grid row (`.field--wide`); `span` spans the whole grid (`.field--span`,
  // Personalization only) — the two collided under one shared name until W64 and stay distinct
  // props here for the same reason.
  //
  // Styled with :global() rather than Svelte's normal component-scoped CSS: AllergyRow.svelte and
  // Allergies.svelte also render a bare `class="field"` span directly in their own templates (a
  // read-only display column reusing the same layout, not a labeled input) rather than through
  // this component, and still need the identical base rules.
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
  /* Uppercase caption above a field. Excludes HeadingAnchor's own inner span so the read-only
     .field usage (AllergyRow/Allergies row) doesn't uppercase-transform the actual patient value
     it wraps in a permalink heading. */
  :global(.field > span:not(.permalink-heading)) {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600;
  }
</style>
