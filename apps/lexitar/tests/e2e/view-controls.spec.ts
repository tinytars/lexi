import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic, openSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubVaultSave } from "./_stubs";

// Group/window/delta rendering is covered by tests/unit/markers-tab.test.ts; these check the wiring.
async function openMarkers(page: Page) {
  await openSynthetic(page);
  await clickNav(page, "Markers");
  await page.waitForSelector(".markers-tab", { timeout: 10_000 });
}

const cards = (page: Page) => page.locator(".markers-tab section.client-section .leaf-card");
const groupRow = (page: Page, label: string) => page.locator(".sidebar .group-list .sub-item", { hasText: label });

test("the Markers view is a single page with no mode or source selector", async ({ page }) => {
  await openMarkers(page);
  await expect(page.locator(".markers-controls select.dropdown")).toHaveCount(1);
  await expect(page.locator(".markers-controls > *")).toHaveCount(1);
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(1);
  expect(await cards(page).count()).toBeGreaterThan(0);
});

test("the sidebar group rows narrow the page to one group at a time (M61 Part A)", async ({ page }) => {
  await openMarkers(page);

  await groupRow(page, "Ratios").click();
  await expect(page.locator(".marker-ratios-screen")).toBeVisible();
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(0);

  // Rows run Ungrouped, Ratios, then the body systems.
  const systemRow = page.locator(".sidebar .group-list .sub-item").nth(2);
  await systemRow.click();
  await expect(page.locator(".marker-ratios-screen")).toHaveCount(0);
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(1);
});

async function routeAccountPatch(page: Page, accountId: string, providerKind: string | null = null) {
  let captured: { unitSystem?: string | null } | null = null;
  await page.route("**/api/account", (route) => {
    if (route.request().method() === "PATCH") {
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        // DISK-SAFETY: fulfilled locally — never write the real dev account row.
        body: JSON.stringify({
          id: accountId, email: `${accountId}@local.invalid`, emailConfirmed: true,
          displayName: accountId, lifecycleStage: "active", providerKind,
          unitSystem: captured?.unitSystem ?? null,
        }),
      });
    }
    return route.continue();
  });
  return { getCaptured: () => captured };
}

test("US|Metric is an always-visible sidebar toggle that switches displayed units (mg/dL ↔ mmol/L)", async ({ page }) => {
  const { getCaptured } = await routeAccountPatch(page, "patient");
  await openSynthetic(page);

  const triglycerides = () => cards(page).filter({ has: page.getByText("Triglycerides", { exact: true }) }).first();
  const showTriglycerides = async () => {
    await clickNav(page, "Markers");
    await page.waitForSelector(".markers-tab", { timeout: 10_000 });
    // Triglycerides has a real mg/dL <-> mmol/L conversion; ApoB/LDL/HDL do not.
    await groupRow(page, "Cardiovascular Risk").click();
    await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });
  };

  // Start from whichever side the account is on rather than assuming US.
  const unitToggle = page.locator(".sidebar .unit-toggle:not(.persona-toggle)");
  const startsOnMetric = await unitToggle.getByRole("button", { name: "Metric" }).evaluate((el) => el.classList.contains("active"));
  const [startUnit, targetLabel, targetUnit] = startsOnMetric ? ["mmol/L", "US", "mg/dL"] : ["mg/dL", "Metric", "mmol/L"];

  await showTriglycerides();
  await expect(triglycerides().locator(".unit").first()).toHaveText(startUnit);

  await unitToggle.getByRole("button", { name: targetLabel }).click();
  await expect(unitToggle.getByRole("button", { name: targetLabel })).toHaveClass(/active/);
  await expect.poll(() => getCaptured() !== null, { timeout: 10_000 }).toBe(true);
  expect(getCaptured()?.unitSystem).toBe(targetLabel === "Metric" ? "metric" : "imperial");

  // The saved preference now drives the Markers display without a reload.
  await expect(triglycerides().locator(".unit").first()).toHaveText(targetUnit);
});

test("a provider's own unit toggle persists to their own account, independent of the patient (M93)", async ({ page }) => {
  const { getCaptured } = await routeAccountPatch(page, "provider", "clinician");
  await openSyntheticAsProvider(page);

  const unitToggle = page.locator(".sidebar .unit-toggle:not(.persona-toggle)");
  const startsOnMetric = await unitToggle.getByRole("button", { name: "Metric" }).evaluate((el) => el.classList.contains("active"));
  const targetLabel = startsOnMetric ? "US" : "Metric";

  await unitToggle.getByRole("button", { name: targetLabel }).click();
  await expect.poll(() => getCaptured() !== null, { timeout: 10_000 }).toBe(true);
  expect(getCaptured()?.unitSystem).toBe(targetLabel === "Metric" ? "metric" : "imperial");
});

test("the time-window selector applies without losing the marker grid", async ({ page }) => {
  await openMarkers(page);
  await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });
  await expect(cards(page).first()).toBeVisible();
});

test("watchlisted markers carry a filled star, unpinned ratios a hollow one (W30/W36/M74)", async ({ page }) => {
  await stubVaultSave(page);
  await openMarkers(page);
  // ApoB is on the synthetic fixture's watchlist.
  await groupRow(page, "Cardiovascular Risk").click();
  const watchStar = cards(page).filter({ hasText: "ApoB" }).first().locator(".pin-star");
  await expect(watchStar).toHaveClass(/visible/);

  // Drive the ratio through both states so the check holds whichever state the vault starts in.
  await groupRow(page, "Ratios").click();
  const ratioStars = page.locator(".marker-ratios-screen .pin-star");
  expect(await ratioStars.count()).toBeGreaterThan(0);
  const ratio = page.locator(".marker-ratios-screen .leaf-card").first();
  const star = ratio.locator(".pin-star");
  const pinnedFirst = await star.evaluate((el) => el.classList.contains("visible"));

  await clickLeafMenuItem(ratio, pinnedFirst ? "Unpin" : "Pin");
  if (pinnedFirst) await expect(star).not.toHaveClass(/visible/);
  else await expect(star).toHaveClass(/visible/);

  await clickLeafMenuItem(ratio, pinnedFirst ? "Pin" : "Unpin");
  if (pinnedFirst) await expect(star).toHaveClass(/visible/);
  else await expect(star).not.toHaveClass(/visible/);
});

test("a marker's definition shows as 'What this is:' in the details panel (W30/M88)", async ({ page }) => {
  await openMarkers(page);
  await groupRow(page, "Cardiovascular Risk").click();
  const card = cards(page).filter({ hasText: "ApoB" }).first();
  await clickLeafMenuItem(card, "Details");
  await expect(card.locator(".mc-meaning")).toContainText("What this is:");
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("a marker row's chart/summary rg-grid stacks the AI summary below the chart (M90)", async ({ page }) => {
    await openSynthetic(page);
    // The sidebar is a closed drawer on phone.
    const toggle = page.locator(".sidebar-toggle");
    if (await toggle.isVisible()) await toggle.click();
    await clickNav(page, "Markers");
    await page.waitForSelector(".markers-tab", { timeout: 10_000 });
    const grid = cards(page).first().locator(".rg-grid").first();
    await expect(grid).toBeVisible();
    const flexDirection = await grid.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirection).toBe("column");

    const chartBox = await grid.locator(":scope > *").first().boundingBox();
    const aiBox = await grid.locator(":scope > *").last().boundingBox();
    expect(chartBox).not.toBeNull();
    expect(aiBox).not.toBeNull();
    expect(aiBox!.y).toBeGreaterThanOrEqual(chartBox!.y + chartBox!.height);
  });
});

