import { expect, type Page } from "@playwright/test";

// Expands a section's All row when it is collapsed (only Notes/Study default to expanded) and
// returns its child rows.
export async function openAllRow(page: Page) {
  const all = page.locator(".sidebar .group-list .side-row").first();
  await expect(all.locator(".sub-item")).toContainText("All");
  const expand = all.locator('.chevron[aria-label^="Expand"]');
  if (await expand.count()) await expand.click();
  const rows = page.locator(".sidebar .group-children .leaf-list .side-row");
  await expect(rows.first()).toBeVisible();
  return rows;
}
