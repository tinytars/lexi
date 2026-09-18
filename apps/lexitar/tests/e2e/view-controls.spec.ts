import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic, openSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { stubVaultSave } from "./_stubs";

// W11c: the Markers view controls (source filter / unit system / time window) and
// the W2 marker delta indicator — all client-side, run against vite dev.
// W33 folded Markers into the Patient tab (Profile→Patient in W37; ex-Doctor Conversation) as a sub-section.
// W36 removed the view-mode selector: Markers is one page — Ratios · Overall — sharing the filters.
// M74 removed the dedicated Watchlist section; starring now bubbles a marker within its own group.
// M76 Phase 2 removed the M61 group filter dropdown; group selection now lives in the sidebar's
// lower zone (`.sidebar .group-list .sub-item`) and the page renders exactly one selected group
// (Ratios or one body-system) instead of every group stacked with non-matching ones hidden.

async function openMarkers(page: Page) {
  await openSynthetic(page);
  await clickNav(page, "Markers");
  await page.waitForSelector(".markers-tab", { timeout: 10_000 });
}

const cards = (page: Page) => page.locator(".markers-tab section.client-section .leaf-card");
const groupRow = (page: Page, label: string) => page.locator(".sidebar .group-list .sub-item", { hasText: label });

test("the Markers view is a single page with no mode or source selector", async ({ page }) => {
  await openMarkers(page);
  // `.markers-controls > *` toHaveCount(1) below is the complete statement of "no mode or source
  // selector" — it admits exactly one control. A separate `.view-toggle` line added nothing and
  // could not fail: that class went out with the mode selector it named.
  // Only the time-window dropdown remains in the header controls (source selector removed, W36b;
  // the M61 group filter dropdown was removed in M76 Phase 2; the M78 text filter was retired in
  // M85 Phase 10 — universal search replaces it).
  await expect(page.locator(".markers-controls select.dropdown")).toHaveCount(1);
  await expect(page.locator(".markers-controls > *")).toHaveCount(1);
  // Ungrouped is the sidebar's default group (M96 Phase 2); its flat block renders on load.
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(1);
  expect(await cards(page).count()).toBeGreaterThan(0);
});

// M61 Part A — the group filter dropdown narrowed the page to one of Ratios/a single Marker
// Levels system at a time. M76 Phase 2 moved group selection into the sidebar's lower zone and
// dropped the "All" option entirely — the page now always renders exactly one group.
// M74 removed the dedicated Watchlist option/section — starring now bubbles a marker within its
// own Marker Levels group instead of duplicating it into a separate filterable section.
test("the sidebar group rows narrow the page to one group at a time (M61 Part A)", async ({ page }) => {
  await openMarkers(page);

  await groupRow(page, "Ratios").click();
  await expect(page.locator(".marker-ratios-screen")).toBeVisible();
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(0);

  // First system row after Ungrouped, Ratios (M96 Phase 2 added the leading Ungrouped row).
  const systemRow = page.locator(".sidebar .group-list .sub-item").nth(2);
  await systemRow.click();
  await expect(page.locator(".marker-ratios-screen")).toHaveCount(0);
  // M80 — the body no longer repeats the sidebar row's group name as its own heading.
  await expect(page.locator(".markers-tab .other-source")).toHaveCount(1);
  // "No heading of its own" asserted structurally: every card sits directly in the group's single
  // flat stack, so there is no intervening wrapper for a heading to sit above. `.source-head` was
  // deleted with the headings themselves, so asserting its absence proved nothing.
  await expectFlatStack(page);
});

/** The group body is one flat list: a single `.stack`, and every card a direct child of it. */
async function expectFlatStack(page: Page) {
  const stack = page.locator(".markers-tab .other-source > .stack");
  await expect(stack).toHaveCount(1);
  const total = await page.locator(".markers-tab .other-source .leaf-card").count();
  expect(total).toBeGreaterThan(0);
  await expect(stack.locator("> .leaf-card")).toHaveCount(total);
}

// M93 — the units control moved from the per-patient Profile field into an always-visible
// sidebar-footer toggle, and now persists account-level (PATCH /api/account) instead of into
// the patient's vault. Replaces the old W42/M57 "per-patient Profile setting" test.
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
    // Triglycerides is a real marker in the synthetic fixture, in the Cardiovascular Risk group (M76
    // Phase 2 — single-group rendering means the right sidebar group must be selected first), and the
    // ANALYTE registry (@pablotech/akesi/unit-systems) defines a genuine mg/dL <-> mmol/L conversion
    // for it — unlike ApoB/LDL/HDL, which the registry expresses in g/L or leaves unconverted.
    await groupRow(page, "Cardiovascular Risk").click();
    await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });
  };

  // The account's actual current preference decides the starting side — don't hardcode US-first,
  // just verify the toggle flips whichever way it starts.
  const unitToggle = page.locator(".sidebar .unit-toggle");
  const startsOnMetric = await unitToggle.getByRole("button", { name: "Metric" }).evaluate((el) => el.classList.contains("active"));
  const [startUnit, targetLabel, targetUnit] = startsOnMetric ? ["mmol/L", "US", "mg/dL"] : ["mg/dL", "Metric", "mmol/L"];

  await showTriglycerides();
  await expect(triglycerides().locator(".unit").first()).toHaveText(startUnit);

  // The toggle is always visible in the sidebar footer — no navigation to Profile required,
  // unlike the old per-patient field.
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

  const unitToggle = page.locator(".sidebar .unit-toggle");
  const startsOnMetric = await unitToggle.getByRole("button", { name: "Metric" }).evaluate((el) => el.classList.contains("active"));
  const targetLabel = startsOnMetric ? "US" : "Metric";

  await unitToggle.getByRole("button", { name: targetLabel }).click();
  await expect.poll(() => getCaptured() !== null, { timeout: 10_000 }).toBe(true);
  // The PATCH persists to the signed-in provider's OWN account row (session.accountId) — never
  // to Alex's vault or account, so it can never collide with the sibling test's patient-side change.
  expect(getCaptured()?.unitSystem).toBe(targetLabel === "Metric" ? "metric" : "imperial");
});

test("the time-window selector applies without losing the marker grid", async ({ page }) => {
  await openMarkers(page);
  await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });
  await expect(cards(page).first()).toBeVisible();
});

// W65 — the window is a per-chart ZOOM, not a filter on the marker set. This is the assertion that
// records that decision: narrowing to the shortest window must not remove a single card from the
// page, and each marker whose readings all fall outside it says so on its own card instead of
// pairing a current-looking value with a plot reading "no data in window".
test("narrowing the window zooms every chart and hides no marker (W65)", async ({ page }) => {
  await openMarkers(page);
  const windowSelect = page.locator(".markers-controls select.dropdown").first();
  const emptyPlots = page.locator(".markers-tab svg text").filter({ hasText: "no data in window" });
  const stale = page.locator(".markers-tab .mc-badge.stale");

  await windowSelect.selectOption({ label: "All time" });
  await expect(cards(page).first()).toBeVisible();
  const allTime = await cards(page).count();
  expect(allTime).toBeGreaterThan(0);
  await expect(emptyPlots).toHaveCount(0);

  await windowSelect.selectOption({ label: "3 months" });
  await expect(cards(page)).toHaveCount(allTime);

  // The fixture's newest reading is staggered by system (READING_AGES_DAYS in
  // synthetic-patient.ts): Cardiovascular Risk's newest reading is 60 days old, inside a 3-month
  // window; Metabolic Health's is 200 days old, outside it — so the shortest window necessarily
  // leaves some (not all) markers with nothing to plot, and the card must SAY so rather than pair
  // an empty plot with a current-looking value. One badge per empty plot, exactly: a count that
  // merely exceeds zero would pass with a single badge among hundreds of silent cards.
  const emptyCount = await emptyPlots.count();
  expect(emptyCount).toBeGreaterThan(0);
  expect(emptyCount).toBeLessThan(allTime);
  await expect(stale).toHaveCount(emptyCount);

  // Its own class and its own text. `.mc-badge.nodata` would not do: three badges share it — "no
  // range", "no data", and this one — so an assertion on it matched the "no range" badge of a marker
  // with readings in the window, and said nothing about staleness at all.
  await expect(stale.first()).toHaveText(/^last \d{4}-\d{2}-\d{2}$/);
  // A delta beside an empty plot reads as movement that just happened.
  await expect(page.locator(".markers-tab .leaf-card", { has: stale.first() }).locator(".mc-delta")).toHaveCount(0);
});

test("watchlisted markers carry a filled star, unpinned ratios a hollow one (W30/W36/M74)", async ({ page }) => {
  await stubVaultSave(page);
  await openMarkers(page);
  // M72 Phase 8 — the standalone star-btn was merged into LeafActionMenu's combined pin-slot.
  // M74 — the dedicated Watchlist block is gone; a watchlisted marker now renders once, in its
  // normal Marker Levels position, bubbled to the top of its group. "ApoB" is a real entry in the
  // synthetic fixture's client.watchlist, in the Cardiovascular Risk group (M76 Phase 2).
  await groupRow(page, "Cardiovascular Risk").click();
  const watchStar = cards(page).filter({ hasText: "ApoB" }).first().locator(".pin-star");
  await expect(watchStar).toHaveClass(/visible/);

  // M74 — ratios now get a real pin-slot too (previously none at all). Switch back to Ratios —
  // Marker Levels and Ratios are separate groups under single-group rendering (M76 Phase 2).
  //
  // W78 — this used to assert "none are pinned by default", true only for a hand-authored vault
  // with no prior reconcile. Drive the row through both states instead and check the star follows:
  // same property, no dependence on which state the vault happens to start in.
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
  // M88 — "Details" expands the row's own MarkerDetails inline (the shared page-level details
  // column was removed).
  await expect(card.locator(".mc-meaning")).toContainText("What this is:");
});

test("system groups combine sources — no Blood/Imaging sub-header even when a group spans both (M102)", async ({ page }) => {
  await openMarkers(page);
  // Cardiovascular Risk spans lab + imaging in the synthetic fixture (its lab markers plus a
  // Coronary Calcium Score). W30 used to split those into source sub-headers; M102 removed that
  // split — every marker in the group now renders in one flat, pinned/concern-ordered list.
  await groupRow(page, "Cardiovascular Risk").click();
  expect(await cards(page).count()).toBeGreaterThan(1);
  // Same structural check as above, and here it is the whole point: a blood/imaging split would
  // have to put the two sets in separate containers, which a single flat stack forbids. The old
  // `.source-sub-head` assertion named a class M102 deleted, so it could not have caught a split
  // reintroduced under any other name.
  await expectFlatStack(page);
});

test("the marker delta indicator renders for a longitudinal series", async ({ page }) => {
  await openMarkers(page);
  await page.locator(".markers-controls select.dropdown").first().selectOption({ label: "All time" });
  const delta = page.locator(".markers-tab .mc-delta").first();
  await expect(delta).toBeVisible();
  expect(await delta.getAttribute("title")).toContain("vs prior");
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("a marker row's chart/summary rg-grid stacks the AI summary below the chart (M90)", async ({ page }) => {
    await openSynthetic(page);
    // M75 — the sidebar is a closed-by-default drawer on phone; open it before navigating.
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

