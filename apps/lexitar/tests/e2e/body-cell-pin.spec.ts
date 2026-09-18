import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem, firstUnpinned } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubVaultSave } from "./_stubs";

// W62 — a pin has two surfaces, the sidebar row and the body cell, and they are the same item.
// Phase 2 gave the generated sections records and wired the sidebar; the cells showed nothing, so
// one surface claimed an item was pinned and the other silently disagreed.

test("pinning an Analysis cell stars it, and the sidebar row agrees", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await clickNav(page, "Analysis");

  const cell = page.locator(".analysis .leaf-card").first();
  await expect(cell).toBeVisible();
  // The heading is CSS-uppercased and carries HeadingAnchor's 🔗, so it is not the row's text
  // verbatim — strip and match case-insensitively rather than compare raw innerText.
  const label = (await cell.locator(".leaf-card-head").innerText()).replace("🔗", "").trim();
  await expect(cell.locator(".pin-star")).not.toHaveClass(/visible/);

  await clickLeafMenuItem(cell, "Pin");
  await expect(cell.locator(".pin-star")).toHaveClass(/visible/);

  // The same item's sidebar row now carries the star too — one record, two views of it.
  // Its group starts collapsed, so expand before looking.
  const expand = page.getByRole("button", { name: /^Expand / }).first();
  if (await expand.count()) await expand.click();
  const row = page
    .locator(".sidebar .group-children .side-row")
    .filter({ has: page.locator(".sub-item", { hasText: new RegExp(`^${label}$`, "i") }) })
    .first();
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
});

test("an Exploration cell pins from the body", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await clickNav(page, "Exploration");

  const cell = page.locator(".leaf-card").first();
  await expect(cell).toBeVisible();
  await expect(cell.locator(".pin-star")).not.toHaveClass(/visible/);
  await clickLeafMenuItem(cell, "Pin");
  await expect(cell.locator(".pin-star")).toHaveClass(/visible/);
});

// #81 — Questions and Glossary were the last two sections rendering a bare PersonaBubble, so their
// W62 records had no cell to sit on. Both are turn cells now, which is what makes these possible.
/** Questions/Glossary/Markers are group rows nested under Notes, not top-level nav rows. */
async function openNotesGroup(page: Page, label: string) {
  await clickNav(page, "Notes");
  await page.locator(".sidebar .group-list .sub-item", { hasText: label }).first().click();
}

test("a Question cell pins from the body", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await openNotesGroup(page, "Questions");

  const cell = page.locator(".questions-dr .leaf-card").first();
  await expect(cell).toBeVisible();
  await expect(cell.locator(".pin-star")).not.toHaveClass(/visible/);
  await clickLeafMenuItem(cell, "Pin");
  await expect(cell.locator(".pin-star")).toHaveClass(/visible/);
});

test("a Glossary cell pins from the body, and shows both halves of the turn", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await openNotesGroup(page, "Glossary");

  const cell = page.locator(".glossary .leaf-card").first();
  await expect(cell).toBeVisible();
  // The cell treatment itself: a glossary term renders as a turn tuple, patient half included,
  // exactly like Study and Exploration — not as a lone AI bubble.
  await expect(cell.locator(".p-assistant")).toBeVisible();
  await expect(cell).toContainText(/Not asked/);

  await clickLeafMenuItem(cell, "Pin");
  await expect(cell.locator(".pin-star")).toHaveClass(/visible/);
});

// W62 P7 — Reports was the odd one out: its body ★ pinned a *diagnosis* (DiseaseEntry.pinned) while
// its sidebar row pinned the *report* (SourceRecord.pinned), so neither star could see the other.
// The card now carries the report's own star; the per-diagnosis stars stay, one level finer.
test("a Report cell pins the report, and its sidebar row agrees", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await clickNav(page, "Reports");

  const first = firstUnpinned(page.locator(".health-reports .leaf-card"), ".leaf-card-head .pin-star");
  await expect(first).toBeVisible();
  const title = (await first.locator(".cr-title").first().innerText()).replace("🔗", "").trim();
  // Pinning re-sorts the list pinned-first, so hold the card by its title rather than by position.
  const cell = page.locator(".health-reports .leaf-card").filter({ has: page.locator(".cr-title", { hasText: title }) }).first();
  await expect(cell.locator(".leaf-card-head .pin-star")).not.toHaveClass(/visible/);

  // Scope to the card's own header row: each diagnosis bubble carries a Pin menu of its own, so
  // `.leaf-menu-trigger` is not unique inside a report cell (same reason as shell-nav.spec.ts and its siblings).
  await clickLeafMenuItem(cell.locator(".leaf-card-head"), "Pin");
  await expect(cell.locator(".leaf-card-head .pin-star")).toHaveClass(/visible/);

  // Report rows sit under per-system groups; expand every one rather than guess which system.
  const expanders = page.getByRole("button", { name: /^Expand / });
  for (let i = (await expanders.count()) - 1; i >= 0; i--) await expanders.nth(0).click();
  const row = page.locator(".sidebar .side-row").filter({ hasText: title }).first();
  await expect(row.locator(".pin-star")).toHaveClass(/visible/);
});

test("a diagnosis pin inside a report stays its own record", async ({ page }) => {
  await stubVaultSave(page);
  await openSyntheticAsProvider(page);
  await clickNav(page, "Reports");

  const cell = firstUnpinned(page.locator(".health-reports .leaf-card"), ".leaf-card-head .pin-star");
  const dx = cell.locator(".rg-dx .p-assistant").first();
  await expect(dx).toBeVisible();
  await clickLeafMenuItem(dx, "Pin");
  await expect(dx.locator(".pin-star")).toHaveClass(/visible/);
  // Pinning a diagnosis must not pin the report that produced it — two levels, two records.
  await expect(cell.locator(".leaf-card-head .pin-star")).not.toHaveClass(/visible/);
});
