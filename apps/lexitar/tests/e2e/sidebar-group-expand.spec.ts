import { test, expect } from "./_fixtures";
import { openPatient } from "./_login";
import { clickNav } from "./_nav";
import { treatmentAnchor } from "../../src/lib/anchor";

// W58 — sidebar group rows gain a VS Code/Claude-Desktop-style expand/collapse chevron, decoupled
// from the row's own label click (which keeps doing whatever it did before this milestone).

test("Notes' All row starts expanded, matching its pre-W58 always-visible behavior", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Notes");
  const chevron = page.locator('.sidebar .chevron[aria-label="Collapse All"]');
  await expect(chevron).toBeVisible();
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sidebar .group-children .sub-item").first()).toBeVisible();
});

test("chevron toggles a group's children without selecting the group (decoupled from the label click)", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Treatment");

  const ongoingRow = page.locator(".sidebar .group-list .side-row", { has: page.locator(".sub-item", { hasText: "Ongoing" }) });
  const chevron = ongoingRow.locator(".chevron");
  const label = ongoingRow.locator(".sub-item");

  // Every non-Ungrouped Treatment row defaults collapsed (W58 decision #2).
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sidebar .group-children")).toHaveCount(0);

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sidebar .group-children .sub-item").first()).toBeVisible();
  // The chevron click must NOT also select/activate the row it belongs to.
  await expect(label).not.toHaveClass(/active/);

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sidebar .group-children")).toHaveCount(0);
});

test("clicking a nested child scrolls to that specific item and activates its parent group", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Treatment");

  const ongoingRow = page.locator(".sidebar .group-list .side-row", { has: page.locator(".sub-item", { hasText: "Ongoing" }) });
  await ongoingRow.locator(".chevron").click();

  // W78 — whichever drug is listed first, not a named one. "Ezetimibe" was on Pablo's Ongoing list
  // when this was written and is not any more; which drugs a patient is on is the fixture's business,
  // and the property under test is that the child scrolls to ITS OWN item, whatever it is.
  const child = page.locator(".sidebar .group-children .sub-item").first();
  const name = (await child.innerText()).trim();
  await child.click();

  await expect(ongoingRow.locator(".sub-item")).toHaveClass(/active/);
  // anchor.ts:25 — treatmentAnchor(name).
  await expect(page.locator(`#${treatmentAnchor(name)}`)).toBeVisible();
});

test("switching sections resets expand state — a key like \"ungrouped\" shared across sections doesn't leak", async ({ page }) => {
  await openPatient(page);

  // Markers' rows default collapsed; expand "Ratios".
  await clickNav(page, "Markers");
  const ratiosRow = page.locator(".sidebar .group-list .side-row", { has: page.locator(".sub-item", { hasText: "Ratios" }) });
  await ratiosRow.locator(".chevron").click();
  await expect(ratiosRow.locator(".chevron")).toHaveAttribute("aria-expanded", "true");

  // Reports also has an "ungrouped"-keyed row, rendered by the same shared branch — it must start
  // fresh (collapsed), not inherit Markers' expand state. (Was Questions, which is now a group row
  // inside Notes rather than a top-level section.)
  await clickNav(page, "Reports");
  const ungroupedRow = page.locator(".sidebar .group-list .side-row", { has: page.locator(".sub-item", { hasText: "All" }) });
  await expect(ungroupedRow.locator(".chevron")).toHaveAttribute("aria-expanded", "false");
});

// The acceptance test for the reported bug ("Chat seems to have a weird smaller All submenu").
// Measured, not eyeballed: Chat used to draw its own All row at 0.8rem with no child indent while
// every other section drew one at 0.88rem/40px indented 1.5rem. Chat is a caller of the shared
// component now, so these must be identical — and if either drifts again, this fails.
