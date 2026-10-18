<script lang="ts">
  // W38 — the GitHub-style grab affordance. Wrap it around a heading/label; a 🔗 appears on hover
  // and copies a shareable permalink to this spot. It reads the *current* hash (kept in sync by the
  // shell) as the base location, so it needs no location props threaded down the tree — only its own
  // anchor. Omit `anchor` for a section/tab-level link (copies the current tab+section as-is).
  import type { Snippet } from "svelte";
  import { parseHash, toHash } from "./permalink";

  interface Props {
    anchor?: string;
    label?: string;
    // Whether this element is the scroll target (sets id={anchor} on itself). Set false when the id
    // already lives on a container/child (e.g. MarkerChart's <figure>) — the 🔗 still copies the link.
    assignId?: boolean;
    children: Snippet;
  }
  let { anchor, label = "Copy link", assignId = true, children }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation(); // don't trigger a row/tab click we're nested inside
    const base = parseHash(window.location.hash);
    if (!base) return;
    const url = window.location.origin + window.location.pathname + toHash({ ...base, anchor });
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return; // clipboard blocked (insecure context / denied) — no link to show, nothing to do
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1200);
  }
</script>

<span class="permalink-heading" id={assignId ? anchor : undefined}>
  {@render children()}
  <button type="button" class="permalink-grab" class:copied onclick={copy} title={label} aria-label={label}>
    {copied ? "✓" : "🔗"}
  </button>
</span>

<style>
  .permalink-heading { scroll-margin-top: 5rem; }
  .permalink-grab {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.75em;
    line-height: 1;
    padding: 0 0.25em;
    margin-left: 0.15em;
    opacity: 0;
    transition: opacity 0.12s;
    color: var(--muted);
  }
  .permalink-heading:hover .permalink-grab,
  .permalink-grab:focus-visible { opacity: 1; }
  .permalink-grab:hover { color: var(--accent); }
  .permalink-grab.copied { opacity: 1; color: var(--accent); }
  /* Touch devices have no hover — keep the control faintly discoverable. */
  @media (hover: none) { .permalink-grab { opacity: 0.5; } }
</style>
