import { expect, type Locator } from "@playwright/test";

// M71 — every leaf's Edit/Chat/Delete/etc now live behind one shared triple-dot LeafActionMenu
// instead of being directly clickable. `row` is any locator that contains exactly one
// `.leaf-menu-trigger` (a row, or the whole page for a single global menu like the chat header's).
//
// M72 Phase 1 made the trigger hover-revealed on a hover-capable pointer whenever the leaf also has
// Pin (`.pin-slot .leaf-menu-trigger` is `display:none` until `.pin-slot:hover`). Playwright's own
// actionability check requires a target to already be visible before it will click it — it won't
// hover an ancestor for you — so a real hover first is required wherever `.pin-slot` exists; leaves
// with no Pin (onTogglePin omitted) render the trigger unconditionally and need no hover.
//
// `force: true` on the hover — flaky (observed on shell-nav.spec.ts's M55/M56 race test, which
// deliberately delays a background /api/leaf-regen response and can shift page layout right as this
// runs): Playwright's default hover waits for the target to be visible AND STABLE (unmoving) first,
// but all this hover needs to do is engage the CSS :hover pseudo-class that reveals the trigger —
// there's no real pointer-precision requirement here, so bypass that wait rather than let a
// transient layout shift elsewhere on the page fail an otherwise-irrelevant stability check. The
// follow-up click on the now-revealed trigger keeps its own normal (non-forced) actionability wait.
//
// W76 — and `force` is also why the hover can silently fail to stick. The event is dispatched at
// whatever coordinates the slot occupied at that instant; if the row then moves — which is exactly
// what the specs that delay a background response do — the pointer is no longer over `.pin-slot`,
// `:hover` drops, the trigger returns to `display:none`, and the click below waits out the FULL
// test timeout on an element that will never appear. That is not a slow test, it is a hang: it cost
// notes.spec.ts and pin-persistence.spec.ts a 30s timeout each on the same CI shard. Retry the
// hover until the trigger it is supposed to reveal is actually there.
export async function openLeafMenu(row: Locator) {
  const pinSlot = row.locator(".pin-slot");
  const trigger = row.locator(".leaf-menu-trigger");
  if ((await pinSlot.count()) === 0) {
    await trigger.click();
    return;
  }
  // W78 — the CLICK has to be inside the retry as well. Asserting the trigger visible and then
  // clicking outside the loop leaves exactly the gap the paragraph above describes: the row can move
  // in between, `:hover` drops, the button goes back to `display:none`, and the click waits out the
  // whole 30s test timeout on an element that will never appear. Two different tests in
  // shell-leaf-regen.spec.ts hung here on the same hosted shard, in two consecutive runs, both at
  // this line — the hover retry alone was never enough.
  await expect(async () => {
    await pinSlot.hover({ force: true });
    await trigger.click({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

// W46 Phase 1 — every popover trigger (LeafActionMenu, AccountMenu) carries a stable
// `aria-controls` pointing at its panel's id, independent of the panel's open/closed state or its
// portaled location in the DOM (`document.body`, not the trigger's row) — use this instead of
// scoping a locator to a row when a test needs to assert a *specific* menu's own open/closed state
// (menuRegistry only guarantees one panel is in the DOM at a time, not which one).
export async function menuPanelFor(trigger: Locator) {
  const panelId = await trigger.getAttribute("aria-controls");
  return trigger.page().locator(`#${panelId}`);
}

export async function leafMenuPanel(row: Locator) {
  return menuPanelFor(row.locator(".leaf-menu-trigger"));
}

// W46 Phase 1 — the panel is now portaled to <body> by the anchoredMenu action (so it can flip/clamp
// itself into the viewport instead of being clipped by an ancestor's overflow/sticky), so it's no
// longer a descendant of `row`. Query from `row.page()` instead — the shared menuRegistry guarantees
// at most one panel is open at a time, so this stays unambiguous.
export async function clickLeafMenuItem(row: Locator, itemName: string | RegExp) {
  await openLeafMenu(row);
  await row.page().getByRole("menuitem", { name: itemName }).click();
}

// W78 — position is not a proxy for pin state, and every spec that used `.first()` as its stand-in
// for "an unpinned example" was relying on one. Every leaf list sortPinnedFirst's, so the moment
// Pablo's vault acquired a single pinned report (the 2026-08-26 reconcile), that record moved to
// the top of Reports and seventeen tests went red at once: the menu on that row reads "Unpin", and
// `clickLeafMenuItem` matches a menu item by exact accessible name, so it waited out the full
// 30s timeout on a "Pin" that was never going to render. Select on the state the test depends on.
export function firstUnpinned(cards: Locator, starSelector = ".pin-star") {
  return cards.filter({ hasNot: cards.page().locator(`${starSelector}.visible`) }).first();
}
