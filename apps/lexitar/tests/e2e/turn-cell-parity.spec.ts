import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickNav, clickProfileSub } from "./_nav";

// Turn cells must match Study's width; the sections once wrapped them in a narrower `.leaf-side`.

async function cardWidth(page: Page, sel: string): Promise<number> {
  const el = page.locator(sel).first();
  await expect(el).toBeVisible();
  return Math.round((await el.boundingBox())!.width);
}

test("every turn cell is the same width as Study's", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Study");
  const reference = await cardWidth(page, ".study .leaf-card");
  expect(reference).toBeGreaterThan(600); // guards against the reference itself collapsing

  await clickNav(page, "Analysis");
  expect(await cardWidth(page, ".analysis .leaf-card")).toBe(reference);

  await clickNav(page, "Exploration");
  expect(await cardWidth(page, ".leaf-card")).toBe(reference);

  await clickNav(page, "Notes");
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Glossary" }).first().click();
  expect(await cardWidth(page, ".glossary .leaf-card")).toBe(reference);
});

// A search hit must render the same AnalysisItemCard as the section, not a bare bubble.
test("an Analysis search hit renders the same cell the section does", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Analysis");
  const sectionWidth = await cardWidth(page, ".analysis .leaf-card");
  const label = (await page.locator(".analysis .leaf-card-head").first().innerText()).replace("🔗", "").trim();

  await clickNav(page, "Search");
  const input = page.locator(".search-panel input").first();
  await input.fill(label);

  const hit = page.locator(".search-results .leaf-card").filter({ hasText: new RegExp(label, "i") }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  // A real leaf card, not a lone bubble — and the same width as the section's.
  expect(await cardWidth(page, ".search-results .leaf-card")).toBe(sectionWidth);
});

// Reports' section and its search preview share one cell component, so they must render alike.
test("a Reports search hit renders the same cell the section does", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Reports");

  const card = page.locator(".health-reports .leaf-card").first();
  await expect(card).toBeVisible();
  const title = (await card.locator(".cr-title").first().innerText()).replace("🔗", "").trim();
  const sectionWidth = await cardWidth(page, ".health-reports .leaf-card");
  // The parts that make it a report cell rather than a generic card.
  await expect(card.locator(".persona-bubble.p-provider")).toBeVisible();

  await clickNav(page, "Search");
  await page.locator(".search-panel input").first().fill(title);

  const hit = page.locator(".search-results .leaf-card").filter({ hasText: new RegExp(title.slice(0, 20), "i") }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await expect(hit.locator(".cr-title")).toContainText(title);
  await expect(hit.locator(".persona-bubble.p-provider")).toBeVisible();
  expect(await cardWidth(page, ".search-results .leaf-card")).toBe(sectionWidth);
});

// Allergy search previews must render the full turn, patient half included.
test("an Allergies search hit renders the turn its section does", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickProfileSub(page, "Allergies");

  const allergen = `W64 parity ${Date.now()}`;
  await page.locator('.side-row-action[aria-label="Add allergy"]').click();
  await page.locator(".az-modal input[type=text]").first().fill(allergen);
  await page.locator(".az-modal input[type=text]").nth(1).fill("Hives");
  await page.locator(".az-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".allergies .saved")).toBeVisible({ timeout: 10_000 });

  await clickNav(page, "Search");
  await page.locator(".search-panel input").first().fill(allergen);
  const hit = page.locator(".search-results .leaf-card").filter({ hasText: allergen }).first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await expect(hit.locator(".persona-bubble.p-owner")).toBeVisible();
  await expect(hit).toContainText("Hives");
});
