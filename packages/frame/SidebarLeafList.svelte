<script lang="ts">
  // THE sidebar row. Every list of individual items in the sidebar can render through this
  // component: a group's expanded children and a thread list alike.
  //
  // It used to be split: SidebarGroupList drew group rows, this drew children, and a thread list
  // drew a hand-rolled copy of both because — and only because — a thread row needs per-row
  // actions and a child row had none. That single missing capability bought a second All row at a
  // different font size, an un-indented child list, a different label colour, and a rail rule that
  // disagreed with the other two. Adding the actions here is what let that hand-rolled copy be
  // deleted.
  //
  // Actions are OPTIONAL and supplied by the caller: absent means no menu, exactly as before. Which
  // sections get which actions is a per-section decision, not something a row can assume.
  import LeafActionMenu from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import DictateButton from "./DictateButton.svelte";
  import type { SidebarLeafRow } from "./sidebar-rows";



  interface Props {
    rows: SidebarLeafRow[];
    // The row currently open, when a row click is a view switch (Chat). Null where a click is a pure
    // scroll-to, which is every other section.
    activeKey?: string | null;
    onSelect: (row: SidebarLeafRow) => void;
    // Per-row menu items, minus Pin/Unpin — LeafActionMenu prepends that itself from `pinFor`.
    actions?: (row: SidebarLeafRow) => LeafMenuItem[];
    // Returning null means this row cannot be pinned, so it shows no ★ and no Pin item.
    pinFor?: (row: SidebarLeafRow) => { pinned: boolean; onTogglePin: () => void } | null;
    // Inline rename, bindable so a caller can start one from elsewhere (Chat's header Rename action
    // targets the currently-open thread).
    renamingKey?: string | null;
    renameText?: string;
    onCommitRename?: () => void;
  }
  let {
    rows, activeKey = null, onSelect, actions, pinFor,
    renamingKey = $bindable(null), renameText = $bindable(""), onCommitRename,
  }: Props = $props();

  function menuFor(r: SidebarLeafRow): { items: LeafMenuItem[]; pin: { pinned: boolean; onTogglePin: () => void } | null } | null {
    const pin = pinFor?.(r) ?? null;
    const items = actions?.(r) ?? [];
    // No capabilities at all → no trigger. A ⋮ that opens an empty menu is worse than no ⋮.
    return pin || items.length > 0 ? { items, pin } : null;
  }
</script>

<div class="leaf-list">
  {#each rows as r (r.key)}
    {@const menu = menuFor(r)}
    <div class="side-row" id={r.domId}>
      {#if renamingKey === r.key}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="rename-input"
          bind:value={renameText}
          onblur={onCommitRename}
          onkeydown={(e) => { if (e.key === "Enter") onCommitRename?.(); if (e.key === "Escape") renamingKey = null; }}
          autofocus
        />
        <DictateButton onResult={(text) => { renameText = renameText ? `${renameText} ${text}` : text; onCommitRename?.(); }} />
      {:else}
        <button class="sub-item" class:active={activeKey === r.key} title={r.label} onclick={() => onSelect(r)}>{r.label}</button>
        {#if menu}
          <div class="row-actions">
            <LeafActionMenu
              items={menu.items}
              pinned={menu.pin?.pinned ?? false}
              onTogglePin={menu.pin ? menu.pin.onTogglePin : undefined}
            />
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  /* Same slot a section's own .group-list occupies below the sidebar's divider — hidden on the
     desktop icon rail, forced visible in the mobile drawer. The container class stays distinct
     from .group-list on purpose: a caller's e2e specs can scope `.sub-item` through it. */
  .leaf-list { display: flex; flex-direction: column; gap: 0.15rem; padding: 0 0.25rem; }
  :global(.sidebar.rail) .leaf-list { display: none; }
  @media (max-width: 640px) {
    :global(.sidebar.rail) .leaf-list { display: flex; }
  }
  .side-row { display: flex; align-items: center; gap: 0.15rem; padding: 0.1rem 0.25rem; }
  .sub-item {
    border: none; background: none; text-align: left; font: inherit; font-size: 0.88rem;
    color: var(--muted); cursor: pointer; padding: 0.45rem 0.4rem; border-radius: 6px; min-height: 40px;
    flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sub-item:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 6%, transparent); }
  /* Matches SidebarGroupList's own .sub-item.active — the label is the highlight pill, not the row.
     Chat used to highlight the whole row instead; one of the two had to go. */
  .sub-item.active { color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .row-actions { display: flex; align-items: center; gap: 0.35rem; flex: none; }
  .rename-input {
    flex: 1; min-width: 0; font: inherit; font-size: 0.88rem; padding: 0.35rem 0.4rem;
    border: 1px solid var(--accent); border-radius: 6px;
  }
  @media (max-width: 640px) {
    .sub-item { min-height: 44px; }
  }
</style>
