import { type Page } from "@playwright/test";
import { clickNav } from "./_nav";

export async function openSearch(page: Page) {
  if (await page.locator(".search-panel").count()) return;
  await clickNav(page, "Search");
}

export async function search(page: Page, query: string) {
  await openSearch(page);
  await page.fill(".search-panel .search-input", query);
}
