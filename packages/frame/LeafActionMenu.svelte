<script module lang="ts">
  import type { LeafMenuItem } from "./menu-items";
  export function openOnly(onOpen?: () => void): LeafMenuItem[] {
    return onOpen ? [{ label: "Open", onClick: onOpen }] : [];
  }
</script>

<script lang="ts">
  import { menuRegistry } from "./menu-registry.svelte";
  import { anchoredMenu } from "./anchored-menu.svelte";

  // M71 — the one shared triple-dot action menu every leaf row uses. Generalizes
  // AccountMenu.svelte's dropdown (trigger + outside-click/Escape-closing role="menu" panel) with a
  // generic items[] prop instead of named callback props, and a ⋮ trigger instead of an avatar.
  // Boolean favorite/pin toggles are NOT items here — they stay their own standalone control next
  // to (not inside) this menu, everywhere a leaf has one.
  interface Props {
    items: LeafMenuItem[];
    label?: string;
    icon?: string;
    pinned?: boolean;
    onTogglePin?: () => void;
    pinDisplay?: "auto" | "hidden";
  }
  let { items, label = "Actions", icon = "⋮", pinned = false, onTogglePin, pinDisplay = "auto" }: Props = $props();

  // M104 — menuId identifies this instance in the shared menuRegistry so opening any other
  // popover (another leaf row, or AccountMenu) closes this one.
  const menuId = $props.id();
  let open = $derived(menuRegistry.isOpen(menuId));
  let root: HTMLDivElement;
  // W46 Phase 1 — the panel itself is portaled to <body> by the anchoredMenu action (so no
  // ancestor's overflow/sticky/transform can clip it), so it's no longer a descendant of `root` —
  // outside-click has to check both. `triggerEl` binds whichever of the two mutually-exclusive
  // trigger buttons below is actually rendered.
  let triggerEl: HTMLButtonElement;
  let panelEl: HTMLDivElement | undefined;
  let menuItems = $derived(
    onTogglePin ? [{ label: pinned ? "Unpin" : "Pin", onClick: onTogglePin }, ...items] : items
  );

  function toggle() { if (open) menuRegistry.close(menuId); else menuRegistry.open(menuId); }
  function close() { menuRegistry.close(menuId); }
  function run(item: LeafMenuItem) {
    if (item.disabled) return;
    close();
    item.onClick();
  }

  function onWindowClick(e: MouseEvent) {
    const target = e.target as Node;
    if (!open) return;
    if (root?.contains(target)) return;
    if (panelEl?.contains(target)) return;
    close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKeydown} />

<div class="leaf-menu" bind:this={root}>
  {#if onTogglePin && pinDisplay === "auto"}
    <div class="pin-slot">
      <span class="pin-star" class:visible={pinned} aria-hidden="true">★</span>
      <button
        bind:this={triggerEl}
        class="leaf-menu-trigger pin-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${menuId}-panel`}
        title={label}
        onclick={toggle}
      >{icon}</button>
    </div>
  {:else}
    <button
      bind:this={triggerEl}
      class="leaf-menu-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={`${menuId}-panel`}
      title={label}
      onclick={toggle}
    >{icon}</button>
  {/if}

  {#if open}
    <div
      id={`${menuId}-panel`}
      class="menu"
      role="menu"
      bind:this={panelEl}
      use:anchoredMenu={{ anchor: triggerEl, open }}
    >
      {#each menuItems as item, i (item.key ?? item.title ?? item.label)}
        {#if item.danger && !menuItems[i - 1]?.danger}<div class="menu-sep"></div>{/if}
        <button
          role="menuitem"
          class="menu-item"
          class:danger={item.danger}
          disabled={item.disabled}
          title={item.title ?? item.label}
          onclick={() => run(item)}
        >{item.icon ? `${item.icon} ` : ""}{item.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .leaf-menu { position: relative; display: inline-block; }
  .leaf-menu-trigger {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: none; background: none;
    border-radius: 6px; font: inherit; font-size: 1.1rem; line-height: 1; color: var(--muted);
    cursor: pointer;
  }
  .leaf-menu-trigger:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--fg); }

  .pin-slot { display: inline-flex; align-items: center; gap: 0.15rem; }
  .pin-slot .pin-star { display: none; font-size: 0.75rem; line-height: 1; color: var(--accent); }
  .pin-slot .pin-star.visible { display: inline-block; }

  @media (hover: hover) and (pointer: fine) {
    .pin-slot { position: relative; width: 28px; height: 28px; gap: 0; }
    .pin-slot .pin-star {
      position: absolute; inset: 0; display: none;
      align-items: center; justify-content: center; font-size: 0.95rem;
    }
    .pin-slot .pin-star.visible { display: flex; }
    .pin-slot:hover .pin-star { display: none; }
    .pin-slot .leaf-menu-trigger.pin-trigger { position: absolute; inset: 0; display: none; }
    .pin-slot:hover .leaf-menu-trigger.pin-trigger { display: inline-flex; }
  }

  /* M73 Phase 2 — bring the trigger up to the app's 44px touch-target convention on phone widths.
     Only .leaf-menu-trigger itself gets a fixed box; .pin-slot stays auto-width (it's a flex row
     that, on touch, can hold the trigger AND a visible ★ status badge side by side — forcing it
     square would clip that). The (hover: hover) and (pointer: fine) block above is unaffected
     since a touch viewport has no fine hover pointer, so the two rules never fight the same box. */
  @media (max-width: 640px) {
    .leaf-menu-trigger { width: 44px; height: 44px; }
    .pin-slot { min-height: 44px; }
  }

  /* W46 Phase 1 — top/left/max-height are set inline by the anchoredMenu action (portaled to
     <body>, position: fixed, flip/clamp math in anchored-menu.svelte.ts); this only sets the
     panel's own look, not its placement. */
  .menu {
    z-index: 90;
    min-width: 160px; padding: 0.3rem; background: white;
    border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    display: flex; flex-direction: column; gap: 0.1rem;
  }
  .menu-item {
    text-align: left; padding: 0.4rem 0.55rem; border: none; background: none; border-radius: 6px;
    font: inherit; font-size: 0.85rem; color: var(--fg); cursor: pointer; white-space: nowrap;
  }
  .menu-item:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .menu-item:disabled { color: var(--muted); cursor: not-allowed; }
  .menu-item:disabled:hover { background: none; }
  .menu-item.danger { color: var(--alert); }
  .menu-sep { height: 1px; background: var(--border); margin: 0.25rem 0.3rem; }
</style>
