<script lang="ts">
  import type { Snippet } from "svelte";

  // The field grid the Add/Edit modals and the two search previews share (W64) — a plain wrapping
  // div, so component-scoped CSS is enough: every caller renders this through the component rather
  // than reusing the bare class name elsewhere.
  interface Props { children: Snippet }
  let { children }: Props = $props();
</script>

<div class="form-grid">{@render children()}</div>

<style>
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.9rem 1.1rem; }
</style>
