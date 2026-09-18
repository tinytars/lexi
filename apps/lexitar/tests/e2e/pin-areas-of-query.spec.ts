import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./_login";
import { E2E_CLINICIAN, mySynthetic } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { interceptVaultSave } from "./_stubs";

// W62 — the five sections that had no per-item record now have one, and a pin in any of them is an
// AREA OF QUERY carried into the next Finding. Two things must be true and neither was before:
// the star survives a real save/reload, and the app SAYS that a pin steers the inference.

async function drillToNotes(page: Page) {
  await page.locator(".roster-name", { hasText: mySynthetic().name }).click();
  await page.waitForSelector(".sidebar .nav-item", { timeout: 10_000 });
  await clickNav(page, "Notes");
  await page.waitForSelector(".sidebar .group-list", { timeout: 10_000 });
}

/** Collapses Notes' own All group and expands Questions, so exactly one child list is on screen. */
async function expandQuestionsOnly(page: Page) {
  const collapseAll = page.getByRole("button", { name: /^Collapse All/ });
  if (await collapseAll.count()) await collapseAll.first().click();
  const expandQuestions = page.getByRole("button", { name: "Expand Questions" });
  if (await expandQuestions.count()) await expandQuestions.click();
  const rows = page.locator(".sidebar .group-children .side-row");
  await expect(rows.first()).toBeVisible();
  return rows.first();
}

test("a pinned Question keeps its star across a save and reload", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await drillToNotes(page);

  const row = await expandQuestionsOnly(page);
  const label = (await row.locator(".sub-item").innerText()).trim();
  // Not already starred — otherwise the assertions below would pass without the pin doing anything.
  await expect(row.locator(".pin-star")).not.toHaveClass(/visible/);
  await clickLeafMenuItem(row, "Pin");
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".roster-list", { timeout: 15_000 });
  await drillToNotes(page);

  // Pinned-first: the row that was pinned is now the group's leading child.
  const reloaded = await expandQuestionsOnly(page);
  await expect(reloaded.locator(".sub-item")).toHaveText(label);
  await expect(reloaded.locator(".pin-star")).toHaveClass(/visible/);
});

// "All pinned items can go into the inference as query, this should NOT be silent" — the notice is
// the non-silent half. It must appear only once something is actually pinned.
test("pinning is announced, not silent", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await drillToNotes(page);

  const notice = page.locator(".sidebar .pinned-note");
  const before = await notice.count();

  const row = await expandQuestionsOnly(page);
  await clickLeafMenuItem(row, "Pin");

  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/steer the next Translation/);
  // And it says WHAT a star means, which is the part that must never drift: a topic, not a fact.
  await expect(notice).toHaveAttribute("title", /AREAS OF QUERY/);
  await expect(notice).toHaveAttribute("title", /never treated as evidence/);
  expect(before).toBeLessThanOrEqual(1);
});
