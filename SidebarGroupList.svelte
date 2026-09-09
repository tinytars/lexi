<script lang="ts">
  import SidebarLeafList from "./SidebarLeafList.svelte";
  import type { SidebarLeafRow, SidebarGroupRow } from "./sidebar-rows";
  import SidebarGroupChevron from "./SidebarGroupChevron.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";



  interface Props {
    rows: SidebarGroupRow[];
    activeKey: string | null;
    // M76/Phase 2 — shown (in place of the rows a not-yet-established grouping would otherwise
    // contribute) when the owning leaf's groups aren't established yet, e.g. Markers/Hypothesis
    // before the Finding's System Analysis has run. Matches PendingGrouping.svelte's wording.
    pendingNote?: string | null;
    onSelect: (key: string) => void;
    // W58 — a click on one of a group's nested children, once expanded; bubbled straight
    // through to SidebarLeafList's own onSelect (a pure "scroll to it," never a view switch).
    // The owning row's key comes along so a caller can activate that group as well as scroll to the
    // child — clicking "Ezetimibe" under Ongoing should land you in Ongoing. This used to happen
    // indirectly, via each leaf's own pendingAnchor reverse-match effect; passing the key makes it
    // explicit and survives a leaf whose current view already contains the anchor.
    onSelectChild?: (row: SidebarLeafRow, groupKey: string) => void;
    // Per-child capabilities, forwarded verbatim to SidebarLeafList — see its Props comment. All
    // optional: a section that supplies none renders children exactly as before, with no menu.
    activeChildKey?: string | null;
    // Both receive the owning group's key: Treatment is the one section whose All row lists a
    // different KIND of thing (whole medicines) than its other rows (single dose periods), so the
    // capabilities differ per group, not just per section.
    childActions?: (row: SidebarLeafRow, groupKey: string) => LeafMenuItem[];
    childPinFor?: (row: SidebarLeafRow, groupKey: string) => { pinned: boolean; onTogglePin: () => void } | null;
    renamingKey?: string | null;
    renameText?: string;
    onCommitRename?: () => void;
  }
  let {
    rows, activeKey, pendingNote = null, onSelect, onSelectChild,
    activeChildKey = null, childActions, childPinFor,
    renamingKey = $bindable(null), renameText = $bindable(""), onCommitRename,
  }: Props = $props();

  // W58 — component-local, not persisted: reset whenever the caller remounts this component
  // (Sidebar.svelte wraps its lower-zone render in {#key lowerZoneKind} so switching sections
  // remounts fresh — otherwise a key like "ungrouped", reused across Markers/Questions/etc.,
  // would leak expand state between unrelated sections that share the same {:else} branch).
  let expanded = $state(new Set(rows.filter((r) => r.defaultExpanded).map((r) => r.key)));

  function toggle(key: string) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    expanded = new Set(expanded);
  }
</script>

<div class="group-list">
  {#each rows as r (r.key)}
    <div class="side-row">
      {#if r.children}
        <SidebarGroupChevron expanded={expanded.has(r.key)} label={r.label} onToggle={() => toggle(r.key)} />
      {/if}
      <button class="sub-item" class:active={activeKey === r.key} title={r.title} onclick={() => onSelect(r.key)}>
        {r.label}{#if r.count !== undefined} ({r.count}){/if}
      </button>
      {#if r.action}
        <button class="side-row-action" title={r.action.label} aria-label={r.action.label}
                onclick={(e) => { e.stopPropagation(); r.action!.onClick(); }}>+</button>
      {/if}
    </div>
    {#if r.children && expanded.has(r.key)}
      <div class="group-children">
        <SidebarLeafList
          rows={r.children}
          activeKey={activeChildKey}
          onSelect={(row) => onSelectChild?.(row, r.key)}
          actions={childActions ? (row) => childActions(row, r.key) : undefined}
          pinFor={childPinFor ? (row) => childPinFor(row, r.key) : undefined}
          bind:renamingKey
          bind:renameText
          {onCommitRename}
        />
      </div>
    {/if}
  {/each}
  {#if pendingNote}<p class="group-pending">ⓘ {pendingNote}</p>{/if}
</div>

<style>
  /* Distinct container class from Sidebar.svelte's own .sub-list — this is a sibling list below
     the divider, not another accordion sub-list, and e2e specs scope `.sidebar .sub-list.show`
     to the top-level accordion specifically; reusing that class here made two elements match.
     Row-level classes (.side-row/.sub-item) are still duplicated verbatim from Sidebar.svelte so
     it renders identically — Svelte's CSS scoping doesn't reach into child-component markup. */
  .group-list { display: flex; flex-direction: column; gap: 0.1rem; padding: 0 0.25rem; }
  :global(.sidebar.rail) .group-list { display: none; }
  @media (max-width: 640px) {
    :global(.sidebar.rail) .group-list { display: flex; }
  }
  .side-row { display: flex; align-items: center; gap: 0.15rem; padding: 0.1rem 0.25rem; }
  .sub-item {
    border: none; background: none; text-align: left; font: inherit; font-size: 0.88rem;
    color: var(--muted); cursor: pointer; padding: 0.45rem 0.4rem; border-radius: 6px; min-height: 40px;
    flex: 1; min-width: 0;
  }
  .sub-item:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .sub-item.active { color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .group-pending { margin: 0.3rem 0.6rem; font-size: 0.78rem; font-style: italic; color: var(--muted); }

  /* W48 — duplicated verbatim from Sidebar.svelte's own .side-row-action, same reason as the row
     classes above: child-component styles don't inherit from the parent's <style> block. */
  .side-row-action {
    flex-shrink: 0; border: none; background: var(--band); color: var(--accent); cursor: pointer;
    font: inherit; font-size: 1.15rem; line-height: 1; padding: 0.4rem 0.5rem; border-radius: 6px;
    min-height: 36px; min-width: 36px;
  }
  .side-row:hover .side-row-action { background: color-mix(in srgb, var(--accent) 16%, transparent); }
  :global(.sidebar.rail) .side-row-action { display: none; }
  @media (max-width: 640px) {
    :global(.sidebar.rail) .side-row-action { display: inline-flex; }
  }

  /* W58 — leading expand/collapse toggle, VS Code/Claude-Desktop style. flex-shrink so it never
     yields its own space to the label; a fixed width keeps ▸/▾ from shifting the label as it
     toggles (▾ is very slightly wider than ▸ in most fonts). */
  /* W58 — a group's nested children, indented one level under its own chevron/label — reuses
     the one concrete indent precedent in this codebase (the pre-M82 .sub-list/.show accordion,
     removed in 1b119e0). */
  .group-children { padding-left: 1.5rem; }
</style>
