// W46 Phase 1 — shared collision-aware positioning for popover panels (LeafActionMenu, AccountMenu).
// Both used to be `position: absolute` with a hard-coded direction (`top: 100%` / `bottom: 100%`),
// so a trigger inside a sticky-bottom container (the chat composer) opened its menu straight off the
// bottom of the viewport. This action portals the panel to <body> (so no ancestor's `overflow` or
// `sticky`/`transform` can clip it) and keeps it positioned in `position: fixed` space, flipping to
// whichever side has room and clamping into the viewport when neither side fully fits.

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}
export interface PanelSize {
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface MenuPlacement {
  top: number;
  left: number;
  maxHeight?: number;
}

const GAP = 4;
const MARGIN = 8;

// Pure so it's unit-testable without a DOM: prefers below-and-right-aligned (the panel's original
// static behavior), flips above when below doesn't fit and above has more room, and as a last
// resort clamps to whichever side has more room with a max-height + scroll instead of ever
// letting either edge escape the viewport.
export function placeMenu(trigger: Rect, panel: PanelSize, viewport: Viewport): MenuPlacement {
  const spaceBelow = viewport.height - trigger.bottom - GAP;
  const spaceAbove = trigger.top - GAP;
  const fitsBelow = panel.height <= spaceBelow;
  const fitsAbove = panel.height <= spaceAbove;

  let top: number;
  let maxHeight: number | undefined;

  if (fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove)) {
    top = trigger.bottom + GAP;
    if (!fitsBelow) maxHeight = Math.max(spaceBelow - MARGIN, 80);
  } else if (fitsAbove) {
    top = trigger.top - GAP - panel.height;
  } else {
    top = MARGIN;
    maxHeight = Math.max(spaceAbove - MARGIN, 80);
  }

  // The 80px floors above are a readability minimum — a 20px-tall scrolling menu is useless — but
  // they are applied to a max-height, and nothing was stopping `top + height` from landing past the
  // viewport's bottom edge. On a short viewport with a tall menu (both `!fitsBelow` and `!fitsAbove`,
  // with more room below) the floor won and the panel's last item sat off-screen: visible, enabled
  // and stable to Playwright, and permanently unclickable — "element is outside of the viewport",
  // retried until the test timed out. The header comment claimed this could not happen; now it holds.
  const height = Math.min(panel.height, maxHeight ?? panel.height);
  top = Math.min(top, viewport.height - MARGIN - height);
  top = Math.max(top, MARGIN);

  let left = trigger.right - panel.width;
  left = Math.min(left, viewport.width - panel.width - MARGIN);
  left = Math.max(left, MARGIN);

  return { top, left, maxHeight };
}

interface AnchoredMenuParams {
  anchor: HTMLElement;
  open: boolean;
}

// Svelte action for the panel element. `anchor` is the trigger button; `open` mirrors the caller's
// own open state (the action doesn't own visibility — the {#if} around the panel does — it only
// needs `open` to know when to (re)compute a placement).
export function anchoredMenu(node: HTMLElement, params: AnchoredMenuParams) {
  let anchor = params.anchor;
  let open = params.open;
  let rafId: number | null = null;

  node.style.position = "fixed";
  node.style.margin = "0";
  document.body.appendChild(node);

  function reposition() {
    if (!open) return;
    const panelRect = node.getBoundingClientRect();
    // `scrollHeight` is the panel's CONTENT height, so it ignores the max-height this function may
    // have set on an earlier pass. Reading the box back instead would feed each placement its own
    // clamped output and ratchet the panel smaller every time it re-ran — harmless while the only
    // triggers were scroll and resize, but not once the observer below re-runs it on our own write.
    const height = Math.max(node.scrollHeight, panelRect.height);
    // A zero measurement is not a small panel, it is one that has not been laid out yet, and placing
    // on it is worse than not placing at all: placeMenu clamps against the height it is GIVEN, so a
    // height of 0 parks the panel flush against the bottom edge and the real content then renders
    // past the fold. Wait for the observer instead.
    if (height === 0 || panelRect.width === 0) return;
    const placement = placeMenu(
      anchor.getBoundingClientRect(),
      { width: panelRect.width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    node.style.top = `${placement.top}px`;
    node.style.left = `${placement.left}px`;
    node.style.maxHeight = placement.maxHeight != null ? `${placement.maxHeight}px` : "";
    node.style.overflowY = placement.maxHeight != null ? "auto" : "";
  }

  // rAF-throttled: scroll/resize can fire many times per frame, and the composer's sticky-bottom
  // scroll is exactly the case this exists to keep smooth. Deliberately does NOT close the menu on
  // scroll — the chat composer's page scrolls under an open menu routinely.
  function scheduleReposition() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      reposition();
    });
  }

  // W70 — keyboard access. The reparent into <body> above is what broke it: the panel emits correct
  // role="menu" / role="menuitem" markup, but once it lives at the end of <body> a Tab from the
  // trigger goes to the NEXT HEADER BUTTON, not into the menu — so the app's primary Delete / Edit /
  // Chat / Translate surface could be opened by keyboard and then not used. Nothing moved focus in,
  // and only Escape was handled.
  //
  // Fixed here, once, rather than in AccountMenu and LeafActionMenu separately: both consumers use
  // this action, so both inherit it, and a third would too.
  const items = (): HTMLElement[] => Array.from(node.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));

  function focusItem(i: number): void {
    const list = items();
    if (list.length === 0) return;
    list[(i + list.length) % list.length].focus();
  }

  function onMenuKeydown(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(list.length - 1); }
    else if (e.key === "Tab") {
      // Trap: with the panel in <body>, letting Tab through would land the user in the page behind
      // the menu with no way back, which is worse than not opening it.
      e.preventDefault();
      focusItem(e.shiftKey ? at - 1 : at + 1);
    }
  }

  /**
   * Send focus back where it came from.
   *
   * Mandatory, not a nicety: the panel is removed from <body> on close, so without this the browser
   * has nowhere sensible to put focus and drops it to <body> — leaving a keyboard user at the top of
   * the document after every menu action.
   */
  function restoreFocus(): void {
    if (node.contains(document.activeElement)) anchor.focus();
  }

  node.addEventListener("keydown", onMenuKeydown);

  if (open) { reposition(); focusItem(0); }
  window.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleReposition);

  // W82 — placement was computed ONCE, at mount, and revisited only if the user scrolled or resized.
  // That made an under-measurement permanent rather than transient: measure the panel before its
  // webfont has reflowed it, and placeMenu clamps against a height that is too small, parking the
  // panel low enough that the real content lands past the bottom of the viewport. Playwright then
  // reported the last menu item as "visible, enabled and stable" AND "outside of the viewport", and
  // retried it for the full 30s test timeout — twice (runs 33072678513 and 33430419142), never
  // reproducibly on an M3, because the measurement is only wrong when layout is slow enough to lose
  // the race. Observing the panel closes the class rather than that one cause: whatever settles late
  // — fonts, async content, a scrollbar appearing — re-places it on the next frame.
  const sizeObserver = new ResizeObserver(scheduleReposition);
  sizeObserver.observe(node);

  return {
    update(newParams: AnchoredMenuParams) {
      anchor = newParams.anchor;
      const wasOpen = open;
      open = newParams.open;
      if (open && !wasOpen) { reposition(); focusItem(0); }
      if (!open && wasOpen) restoreFocus();
    },
    destroy() {
      restoreFocus(); // before the node goes, or focus lands on <body>
      node.removeEventListener("keydown", onMenuKeydown);
      sizeObserver.disconnect();
      window.removeEventListener("scroll", scheduleReposition, true);
      window.removeEventListener("resize", scheduleReposition);
      if (rafId != null) cancelAnimationFrame(rafId);
      // The mount-time appendChild above reparents `node` into <body>, putting it outside the
      // marker range Svelte tears the surrounding {#if} down by — so Svelte cannot remove it and
      // the panel is orphaned there, still rendered at its last position with its last content and
      // its menuitems still in the accessibility tree. That is how two "Delete" items could both
      // resolve at once (menu-exclusivity.spec.ts) after deleting the rows owning them. Having
      // appended the node, this action must remove it; `remove()` is a no-op if something already did.
      node.remove();
    },
  };
}
