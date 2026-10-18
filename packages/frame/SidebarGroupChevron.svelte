<script lang="ts">
  // The expand/collapse chevron of a sidebar group row, extracted so Chat's thread list can carry an
  // identical one.
  //
  // Chat cannot simply use SidebarGroupList: that component renders its children as SidebarLeafRows,
  // which have no per-row action slot, and a thread row needs rename/pin/delete. So the header is the
  // shareable part and the list body is not. Sharing it keeps the glyph, the aria-expanded state and
  // — the part a test selects on — the "Collapse <label>" / "Expand <label>" aria-label identical in
  // both places, rather than a second hand-rolled copy that drifts the first time either changes.
  interface Props {
    expanded: boolean;
    label: string;
    onToggle: () => void;
  }
  let { expanded, label, onToggle }: Props = $props();
</script>

<button
  class="chevron"
  aria-expanded={expanded}
  aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
  onclick={(e) => { e.stopPropagation(); onToggle(); }}
>{expanded ? "▾" : "▸"}</button>

<style>
  /* These styles belong to the chevron itself, not to whoever renders it. They lived in
     SidebarGroupList's scoped block, so extracting the button left every group chevron in the app
     unstyled — a raw boxed <button> — while Chat's copy, which had its own :global override, stayed
     correct. Scoped CSS only reaches a component's own markup; a shared element has to carry it. */
  .chevron {
    flex-shrink: 0; border: none; background: none; color: var(--muted); cursor: pointer;
    font: inherit; font-size: 0.75rem; line-height: 1; padding: 0.4rem; width: 1.4rem;
    text-align: center; border-radius: 6px;
  }
  .chevron:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 10%, transparent); }
</style>
