import { test, expect } from "./_fixtures";
import { openPatient, openAsProvider } from "./_login";
import { openLeafMenu, leafMenuPanel } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubChatHistory } from "./_stubs";

// W46 Phase 1 — regression coverage for the reported bug: LeafActionMenu's popover used to be
// `position: absolute; top: calc(100% + 4px)` with no viewport-collision handling, so a trigger
// living inside a sticky-bottom container (the chat composer, `.chat-input { position: sticky;
// bottom: 0 }`) opened its panel straight off the bottom of the viewport. The fix
// (anchored-menu.svelte.ts) portals the panel to <body> and flips/clamps it into the viewport.
// These assert the panel's own bounding box, not just that *a* click succeeded — that's the part a
// hard-coded `top: 100%` could still pass while visually clipping off-screen.

test("chat '+' menu (composer sticky at the viewport bottom) opens fully inside the viewport", async ({ page }) => {
  await stubChatHistory(page);
  await openPatient(page);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });

  const composer = page.locator(".chat-input");
  await expect(composer).toBeVisible();

  const trigger = composer.locator(".leaf-menu-trigger");
  await trigger.click();
  const panel = await leafMenuPanel(composer);
  await expect(panel).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
});

test("a leaf row's ⋮ menu near the top of a scrolled page opens fully inside the viewport", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await clickNav(page, "Treatment");

  const row = page.locator(".unified-treatment .leaf-card").filter({ has: page.locator(".leaf-menu-trigger") }).first();
  await expect(row).toBeVisible();
  // Pin the row to the very top of the scrollable content so its trigger sits close to y=0 — the
  // mirror-image case of the composer-at-the-bottom test above (there, "below" doesn't fit; here,
  // if the panel were pinned to open "above" by a hard-coded rule, it'd clip off the top instead).
  await row.evaluate((el) => el.scrollIntoView({ block: "start" }));

  await openLeafMenu(row);
  const panel = await leafMenuPanel(row);
  await expect(panel).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
});
