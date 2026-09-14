import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider } from "./_login";
import { clickNav } from "./_nav";
import { clickLeafMenuItem, firstUnpinned } from "./_leaf-menu";
import { stubVaultSave } from "./_stubs";

// W64 / #100 — SearchPanel took no pin handler at all, so no search result showed a star even
// though five of its preview components already accepted one. It passes App's own sidebarTogglePin
// now, so a hit pins the SAME record its section does — not a parallel one.
async function search(page: Page, text: string) {
  await page.locator(".sidebar .nav-item, .sidebar .side-row").filter({ hasText: "Search" }).first().click();
  await page.locator(".search-panel input").first().fill(text);
}

test("an Analysis hit pins from search, and the section agrees", async ({ page }) => {
  await stubVaultSave(page);
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Analysis");

  const cell = firstUnpinned(page.locator(".analysis .leaf-card"));
  const head = cell.locator(".leaf-card-head");
  const label = (await head.innerText()).replace("🔗", "").trim();
  // W78 — the hit is identified by the leaf's ANCHOR, not by its label text. An Analysis block's
  // label is a tag word ("LATEST", "OVERALL"), so `hasText: /LATEST/i` matched four results here and
  // `.first()` was whichever one the current data happened to sort first — a chat row, whose menu
  // offers only Open. Both surfaces render the same `permalink-heading` id for one record, which is
  // exactly the "one record, two surfaces" claim this test makes.
  const anchor = await head.locator(".permalink-heading").first().getAttribute("id");

  await search(page, label);
  const hit = page.locator(".search-results .leaf-card").filter({ has: page.locator(`[id="${anchor}"]`) }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await clickLeafMenuItem(hit, "Pin");
  await expect(hit.locator(".pin-star")).toHaveClass(/visible/);

  // Back in its own section, the same item carries the star: one record, two surfaces.
  await clickNav(page, "Analysis");
  const same = page.locator(".analysis .leaf-card").filter({ has: page.locator(`[id="${anchor}"]`) }).first();
  await expect(same.locator(".pin-star")).toHaveClass(/visible/);
});

test("a Reports hit pins the report itself from search", async ({ page }) => {
  await stubVaultSave(page);
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Reports");

  const card = firstUnpinned(page.locator(".health-reports .leaf-card"), ".leaf-card-head .pin-star");
  const title = (await card.locator(".cr-title").first().innerText()).replace("🔗", "").trim();

  await search(page, title);
  const hit = page.locator(".search-results .leaf-card").filter({ has: page.locator(".cr-title", { hasText: title }) }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await clickLeafMenuItem(hit.locator(".leaf-card-head"), "Pin");
  await expect(hit.locator(".leaf-card-head .pin-star")).toHaveClass(/visible/);

  await clickNav(page, "Reports");
  const same = page.locator(".health-reports .leaf-card").filter({ has: page.locator(".cr-title", { hasText: title }) }).first();
  await expect(same.locator(".leaf-card-head .pin-star")).toHaveClass(/visible/);
});
