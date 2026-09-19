import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic, openSyntheticAsProvider, reloadOntoPatient } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubChatHistory, interceptVaultSave } from "./_stubs";

// A pin on a freshly added Study row survives a real save and reload, with the vault PUT captured and replayed.

async function openStudy(page: Page) {
  await clickNav(page, "Study");
  await page.waitForSelector(".study", { timeout: 10_000 });
}

test("Study Pin persists across reload (M71 P6)", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);
  const label = `E2E Pin Study ${Date.now()}`;

  await openSyntheticAsProvider(page);
  await openStudy(page);

  await page.getByTitle("Add study").click();
  await page.getByRole("dialog", { name: "Add study" }).locator(".topic-input").fill(label);
  await page.getByRole("dialog", { name: "Add study" }).getByRole("button", { name: "Save" }).click();

  const row = page.locator(".study .leaf-card", { hasText: label });
  await clickLeafMenuItem(row, "Pin");
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);

  await reloadOntoPatient(page);
  await openStudy(page);

  const reloadedRow = page.locator(".study .leaf-card", { hasText: label });
  await expect(reloadedRow.locator(".pin-star")).toHaveClass(/visible/);
});

// The sidebar row is the only place a pinned chat thread's star renders.
test("Chat Pin shows on the sidebar row (M72 Phase 8)", async ({ page }) => {
  await stubChatHistory(page);
  await openSynthetic(page);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });

  // An untitled thread's row label is also "New chat", so scope to the action button.
  await page.locator('.side-row-action[title="New chat"]').click();
  const row = page.locator(".sidebar .leaf-list .side-row").filter({ has: page.locator(".sub-item.active") });
  await clickLeafMenuItem(row, "Pin");
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
});
