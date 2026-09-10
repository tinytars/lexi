<script lang="ts">
  import type { Snippet } from "svelte";

  // A hoisted ".btn"/".btn.primary" rule, now the component itself rather than a class-name
  // convention. `class` carries a caller's own local variant (`.done`, `.del`, …) alongside the
  // base classes this renders — those variants' rule bodies stay local to the caller, targeted
  // with `:global()` since the element now lives in this component's scope, not the caller's.
  interface Props {
    class?: string;
    primary?: boolean;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    [key: string]: unknown;
  }
  let { class: extraClass = "", primary = false, disabled = false, type = "button", onclick, children, ...rest }: Props = $props();
</script>

<button {type} class="btn {extraClass}" class:primary {disabled} {onclick} {...rest}>{@render children()}</button>

<style>
  .btn { font: inherit; font-size: 0.9rem; border-radius: 6px; cursor: pointer; padding: 0.45rem 0.9rem; border: 1px solid var(--border); background: white; color: var(--fg); }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: white; }
  .btn.primary:disabled { opacity: 0.5; cursor: default; }
  @media (max-width: 640px) { .btn { min-height: 44px; } }
</style>
