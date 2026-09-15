import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { loginAs, openPatient, PILOTS } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubChatHistory, interceptVaultSave } from "./_stubs";

// M71 P8 — the Pin toggle round-trips through a real save/reload, same disk-safety shape as
// editor-roundtrip.spec.ts: intercept the vault PUT, capture the re-encrypted blob, and replay it on
// the next GET so public/data-*.enc is never touched. Covers Study (Phase 6) against a freshly
// added row so no seed data is mutated.
// M72 — the standalone `.persona-pin` button was replaced by the combined star/⋮ `LeafActionMenu`
// control (pin-first menu item); the pin/reload assertions below now go through that control and
// check the non-interactive `.pin-star.visible` status badge instead of the old button's own class.

async function drillToStudy(page: Page) {
  await page.locator(".roster-name", { hasText: "Alex" }).click();
  await page.waitForSelector('.sidebar .nav-item', { timeout: 10_000 });
  await clickNav(page, "Study");
  await page.waitForSelector(".study", { timeout: 10_000 });
}

test("Study Pin persists across reload (M71 P6)", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);
  const label = `E2E Pin Study ${Date.now()}`;

  await page.goto("/", { waitUntil: "networkidle" });
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  await drillToStudy(page);

  await page.getByTitle("Add study").click();
  await page.getByRole("dialog", { name: "Add study" }).locator(".topic-input").fill(label);
  await page.getByRole("dialog", { name: "Add study" }).getByRole("button", { name: "Save" }).click();

  const row = page.locator(".study .leaf-card", { hasText: label });
  await clickLeafMenuItem(row, "Pin");
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".roster-list", { timeout: 15_000 });
  await drillToStudy(page);

  const reloadedRow = page.locator(".study .leaf-card", { hasText: label });
  await expect(reloadedRow.locator(".pin-star")).toHaveClass(/visible/);
});

// M72 Phase 8 — the open-thread header's LeafActionMenu previously forced pinDisplay="hidden",
// always showing bare ⋮ even for a pinned thread. M77 Phase 2 removed that header entirely (pure
// duplication of the sidebar row's own LeafActionMenu), so the sidebar row is now the only place a
// pinned thread's star renders — this just confirms Pin still works there.
test("Chat Pin shows on the sidebar row (M72 Phase 8)", async ({ page }) => {
  await stubChatHistory(page);
  await openPatient(page);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });

  // Scoped to the sidebar action button, not a bare title match — an untitled thread's own
  // sidebar row label defaults to the same "New chat" title text and would otherwise collide.
  await page.locator('.side-row-action[title="New chat"]').click();
  const row = page.locator(".sidebar .leaf-list .side-row").filter({ has: page.locator(".sub-item.active") });
  await clickLeafMenuItem(row, "Pin");
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
});
