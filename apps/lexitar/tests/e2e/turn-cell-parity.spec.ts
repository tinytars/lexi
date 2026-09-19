import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickNav, clickProfileSub } from "./_nav";

// W62 — measured, not eyeballed. A turn cell is a TWO-column card, but several sections still wrapped
// theirs in `.leaf-side` — a single-column max-width left over from when they were lone AI bubbles.
// The cards came out visibly narrower than Study's and Treatment's, which is the pattern they were
// converted to match in the first place.

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

// Every title in the app sits INSIDE its leaf card. Analysis had a block heading outside the cards,
// which also duplicated the cell's own title on the single-item blocks ("On Treatment" above
// "ON TREATMENT"). The block keeps its anchor — permalinks still resolve — but not a visible heading.
test("Analysis renders no headings outside its cells, and keeps its anchors", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Analysis");
  await expect(page.locator(".analysis .leaf-card").first()).toBeVisible();
  await expect(page.locator(".analysis h2")).toHaveCount(0);
  // The section still carries the id the sidebar and permalinks scroll to.
  await expect(page.locator(".analysis .an-block[id]").first()).toHaveCount(1);
});

// W62 — an Analysis hit in search rendered a bare PersonaBubble: no card, no anchor, no star, while
// the same item in Analysis was a full turn cell. It renders the shared AnalysisItemCard now, so
// this asserts the two surfaces agree — the same check the plan called for once search had a cell.
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

// W63 — Reports rendered its cell twice: inline in HealthReports and again in ReportRow for the
// search preview, differing only in class prefix. They had already drifted (the section grew
// per-diagnosis pins, the preview did not). One component now serves both, so this asserts the two
// surfaces still show the same report the same way.
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

// W64 — AllergyRow/FamilyRow were the last two search previews rendering a bare card of spans while
// their sections rendered a two-persona turn. Both are turns now; this asserts the patient half is
// really there, since a scoped-CSS or snippet mistake would still render *something*.
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
