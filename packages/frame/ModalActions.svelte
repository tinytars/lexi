<script lang="ts">
  import type { Snippet } from "svelte";

  // Slot wrapper for the Cancel/Save button row hoisted across every leaf editor's Add/Edit modal.
  interface Props { children: Snippet }
  let { children }: Props = $props();
</script>

<div class="modal-actions">{@render children()}</div>

<style>
  .modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.4rem; }
</style>
