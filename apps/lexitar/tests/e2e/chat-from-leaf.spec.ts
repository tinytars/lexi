import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openPatient, openAsProvider } from "./_login";
import { clickLeafMenuItem, openLeafMenu } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubChatHistory } from "./_stubs";

// M70 — every leaf grows a labeled "Chat" action (Phase 0-3) that seeds a brand-new assistant
// thread from that leaf's resolved reference (the same card M69 builds for a pasted permalink),
// plus a below-fold layout fix for the chat input on small screens (Phase 4). Reuses
// chat-reference-cards.spec.ts's ReferenceCard selectors/assertions rather than reinventing them.

// M75 — on phone the sidebar is a closed-by-default drawer; open it first if the hamburger is
// showing (it's hidden/moot on desktop, where the sidebar is always visible).
async function openSidebarIfDrawer(page: Page) {
  const toggle = page.locator(".sidebar-toggle");
  if (await toggle.isVisible()) await toggle.click();
}

async function openMarkers(page: Page) {
  await stubChatHistory(page);
  await openPatient(page);
  await openSidebarIfDrawer(page);
  await clickNav(page, "Markers");
}

async function openProviderTreatment(page: Page) {
  await stubChatHistory(page);
  await openAsProvider(page, "Alex");
  await openSidebarIfDrawer(page);
  await clickNav(page, "Treatment");
}

// Confirms the click landed on the Chat tab with a freshly seeded thread: one turn, rendered as a
// ReferenceCard (chat-reference-cards.spec.ts's own idiom), titled from the leaf's preview.
async function assertSeededChat(page: Page, expectedTitlePrefix: string, tag: string) {
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Chat" })).toHaveClass(/active/);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  const card = page.locator(".reference-card").last();
  await expect(card).toBeVisible();
  await expect(card.locator(".reference-tag")).toHaveText(tag);
  await expect(page.locator(".chat-body .leaf-card")).toHaveCount(1);
  // M77 Phase 2 — the open thread's title no longer renders in ChatTab's (removed) header; it's
  // shown only in the sidebar's active thread row (SidebarLeafList's `.sub-item.active`).
  const title = ((await page.locator(".sidebar .leaf-list .sub-item.active").textContent()) ?? "").trim();
  expect(title.startsWith(expectedTitlePrefix)).toBe(true);
}

test("Chat button on a treatment row seeds a new thread titled from the treatment, with a reference-card turn", async ({ page }) => {
  await openProviderTreatment(page);

  const row = page.locator(".unified-treatment .leaf-card")
    .filter({ has: page.locator(".leaf-menu-trigger") })
    .first();
  // Strips HeadingAnchor's trailing 🔗/✓ copy-link glyph so the comparison is on the drug name alone.
  const name = ((await row.locator(".ct-drug").textContent()) ?? "").replace(/[🔗✓]+\s*$/u, "").trim();
  expect(name.length).toBeGreaterThan(0);

  await clickLeafMenuItem(row, "Chat");
  await assertSeededChat(page, name, "Treatment");
});

test("Chat button in a marker's star/info row seeds a new thread titled from the marker, with a reference-card turn", async ({ page }) => {
  await openMarkers(page);
  // M96 Phase 2 — Markers now defaults to Ungrouped, which already renders plain (non-ratio)
  // marker figures flat; no group click needed to make one mount.

  const figure = page.locator('.leaf-card[id^="chart-"]:not([id^="chart-ratio-"]):not([id^="chart-watch-"])').first();
  const name = ((await figure.locator(".marker-name").textContent()) ?? "").trim();
  expect(name.length).toBeGreaterThan(0);

  await clickLeafMenuItem(figure, "Chat");
  await assertSeededChat(page, name, "Marker");
});

test.describe("phone viewport", () => {
  test("chat-input stays fully within the viewport after opening a leaf-seeded chat (Phase 4 below-fold regression)", async ({ page }) => {
    // 390x800 (shell-phone.spec.ts's phone-viewport convention). Uses the treatment row rather than
    // a marker chart — the first treatment row sits above the fold at this size, so no incidental
    // scroll-into-view happens before the click; this isolates the composer-visibility guarantee from
    // an unrelated concern (scroll position carrying over across a tab switch). M92 Phase 6 replaced
    // the original Phase 4 fix (a JS-measured `.chat-tab` height compensating for banners above it)
    // with `position: sticky; bottom: 0` on `.chat-input` — a CSS-native guarantee that holds
    // regardless of what renders above the chat tab, so this assertion still applies unchanged.
    await page.setViewportSize({ width: 390, height: 800 });
    await openProviderTreatment(page);

    const row = page.locator(".unified-treatment .leaf-card")
      .filter({ has: page.locator(".leaf-menu-trigger") })
      .first();
    await clickLeafMenuItem(row, "Chat");
    await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Chat" })).toHaveClass(/active/);
    await page.waitForSelector(".chat-input", { timeout: 10_000 });

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const box = await page.locator(".chat-input").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  });
});

test("every leaf action (Edit/Chat/Delete/etc) renders as a labeled item inside one triple-dot LeafActionMenu — PersonaBubble-driven and bespoke leaves alike", async ({ page }) => {
  await openAsProvider(page, "Alex");

  // PersonaBubble-driven: UnifiedTreatment's rowActions() (M66/M70/M71 idiom) — M71 collapsed
  // Edit/Chat/Delete into one LeafActionMenu; all three are labeled menu items now, including
  // Delete (previously a bare unlabeled icon).
  // W46 Phase 1 — the panel is portaled to <body> by the anchoredMenu action (so it can flip/clamp
  // into the viewport), so it's no longer a descendant of `row`; assertions query `page` instead —
  // the shared menuRegistry guarantees at most one panel is open at a time.
  await clickNav(page, "Treatment");
  const row = page.locator(".unified-treatment .leaf-card").filter({ has: page.locator(".leaf-menu-trigger") }).first();
  await openLeafMenu(row);
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();

  // Outside-click also closes the menu, not just Escape.
  await openLeafMenu(row);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("menu")).not.toBeVisible();

  // Study.svelte (M71 Phase 3) — also migrated to LeafActionMenu now, same shape as Treatment above.
  await clickNav(page, "Study");
  const studyRow = page.locator(".study .leaf-card").first();
  await openLeafMenu(studyRow);
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();
});
