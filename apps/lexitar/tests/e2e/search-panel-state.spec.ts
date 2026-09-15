import { test, expect } from "./_fixtures";
import { openAsProvider, openPatient, PILOTS } from "./_login";
import { clickNav } from "./_nav";
import { openSearch, search } from "./_search";

// Split out of search.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd partway through a long
// spec, and `--shard` partitions by FILE, so one oversized file sets the floor for every slice.
// This half: what the panel remembers — the query across a reload, Escape's two stages, the
// empty-results state, and the close button.

test("opening Search deactivates whichever sidebar row was previously active (M104)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await clickNav(page, "Notes");
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Notes" })).toHaveClass(/active/);

  await clickNav(page, "Search");
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Search" })).toHaveClass(/active/);
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Notes" })).not.toHaveClass(/active/);
});

// M105 — the query (never the derived results, which are recomputed live) is now persisted across
// a full reload, not just across an in-session navigate-away-and-back like M104's resume behavior.
// Uses an owner login (not a provider) — a provider reload always drops back to the roster (W49's
// session-resume only re-opens an owner's own vault), so it's the only way to exercise a real reload.
test("the search query survives a full page reload (M105)", async ({ page }) => {
  await openPatient(page, PILOTS.alex);
  await search(page, "cortisol");
  await expect(page.locator(".search-group").first()).toBeVisible();

  await page.reload();
  await page.waitForSelector(".sidebar .nav-item");
  await clickNav(page, "Search");
  await expect(page.locator(".search-panel .search-input")).toHaveValue("cortisol");
  await expect(page.locator(".search-group").first()).toBeVisible();
});

test("Escape clears a non-empty query first, then closes the panel on a second press (M91)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await search(page, "cortisol");
  await expect(page.locator(".search-group").first()).toBeVisible();

  const input = page.locator(".search-panel .search-input");
  await input.press("Escape");
  await expect(page.locator(".search-panel.home")).toBeVisible();

  await input.press("Escape");
  await expect(page.locator(".search-panel")).toHaveCount(0);
});

test("a query with no matches shows the empty-results state, not a blank panel (M91)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await search(page, `no such term ${Date.now()}`);
  await expect(page.locator(".search-panel.home")).toHaveCount(0);
  await expect(page.locator(".search-group")).toHaveCount(0);
  await expect(page.locator(".search-empty")).toBeVisible();
});

test("the close button closes the panel without navigating (M91)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await openSearch(page);
  await expect(page.locator(".search-panel")).toBeVisible();

  await page.locator(".search-close").click();
  await expect(page.locator(".search-panel")).toHaveCount(0);
});
