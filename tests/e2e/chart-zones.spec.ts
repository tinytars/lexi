import { test, expect } from "./_fixtures";
import { openPatient } from "./_login";
import { clickNav } from "./_nav";

// M60 Part C — MarkerChart's y-scale is a piecewise banded scale (src/lib/chart-scale.ts) rather
// than a flat linear map, so a zone's rendered pixel height no longer collapses to a sub-visible
// sliver just because another zone spans a much wider value range. This is a rendering smoke test;
// the scale math itself (floors, outlier extension) is covered directly in
// tests/unit/chart-scale.test.ts against synthetic inputs.

const cards = (page: import("@playwright/test").Page) => page.locator(".markers-tab section.client-section .leaf-card");

test("a chart's safe zone renders as a visible band, not a sub-pixel sliver", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Markers");
  await page.waitForSelector(".markers-tab", { timeout: 10_000 });
  await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });

  // Find the first chart that actually has a personalized range (a safe-zone rect present).
  const safeRects = cards(page).locator('svg rect[fill="var(--safe-band)"]');
  await expect(safeRects.first()).toBeVisible();

  const heights = await safeRects.evaluateAll((els) => els.map((el) => Number(el.getAttribute("height"))));
  expect(heights.length).toBeGreaterThan(0);
  // plotH is 74px (H=110 minus top/bottom padding) — the banded scale's 25% safe floor means
  // no safe zone should ever render below a few pixels, unlike the old linear scale's ~1.1px case.
  expect(Math.max(...heights)).toBeGreaterThan(5);
});
