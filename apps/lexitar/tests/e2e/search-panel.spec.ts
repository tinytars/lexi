import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickNav } from "./_nav";
import { openSearch, search } from "./_search";

// Split out of search.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd partway through a long
// spec, and `--shard` partitions by FILE, so one oversized file sets the floor for every slice.
// This half: the panel as a surface — home vs results layout, opening, closing, refocusing.

test("clicking the Search nav row shows a centered home box with no results (M91)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await openSearch(page);
  await expect(page.locator(".search-panel.home")).toBeVisible();
  await expect(page.locator(".search-group")).toHaveCount(0);
});

test("typing a query flips the panel to the top-left/results layout without losing input focus (M91)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await openSearch(page);
  const input = page.locator(".search-panel .search-input");
  await input.click();
  await input.type("ApoB");
  await expect(page.locator(".search-panel.home")).toHaveCount(0);
  await expect(page.locator(".search-group").first()).toBeVisible();
  await expect(input).toBeFocused();
});

test("clicking a different sidebar nav row while search is open closes the panel (M91)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await search(page, "ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();

  await clickNav(page, "Notes");
  await expect(page.locator(".search-panel")).toHaveCount(0);
  await expect(page.locator(".notes")).toBeVisible();
});

test("re-clicking Search while already open keeps the existing query/results and refocuses the input (M104)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await search(page, "ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();

  // Bypasses openSearch()'s early-return (it skips clickNav once .search-panel is already present) —
  // this is the exact re-click-while-open path that helper is written to never exercise.
  await clickNav(page, "Search");
  const input = page.locator(".search-panel .search-input");
  await expect(input).toHaveValue("ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();
  await expect(input).toBeFocused();
});

test("navigating away and back to Search resumes the last query/results (M104)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await search(page, "ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();

  await clickNav(page, "Notes");
  await expect(page.locator(".search-panel")).toHaveCount(0);
  await clickNav(page, "Search");
  await expect(page.locator(".search-panel .search-input")).toHaveValue("ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();
});

test("the sidebar Search row's \"+\" clears the query, shows the home state, and refocuses the input (M104)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await search(page, "ApoB");
  await expect(page.locator(".search-group").first()).toBeVisible();

  await page.locator('.side-row-action[aria-label="Start a fresh search"]').click();
  const input = page.locator(".search-panel .search-input");
  await expect(input).toHaveValue("");
  await expect(page.locator(".search-panel.home")).toBeVisible();
  await expect(input).toBeFocused();
});
