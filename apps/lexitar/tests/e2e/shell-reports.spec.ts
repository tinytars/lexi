import { test, expect } from "./_fixtures";
import { openAsProvider, PILOTS } from "./_login";
import { clickLeafMenuItem, openLeafMenu } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { watchFlashes, expectFlashed } from "./_flash";
import { unlock } from "./_shell";

// Health Reports and the exports that read from them — the Hospital-report → LexiTar-diagnosis
// mapping, the ✎ edit modal, the per-report download and delete, and the CSV/JSON exports.
//
// Reports delete appears twice on purpose: once from a provider session and once from a patient's
// own (W34/M51), because the affordance being provider-only was the bug.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

test("Export downloads a CSV and a JSON", async ({ page }) => {
  await unlock(page, "Alex");
  // M78 Phase 6 moved Export off the header into the Profile sidebar row; M84 moved it again, off
  // the sidebar entirely and into the bottom-left account menu.
  await page.click(".account-trigger");
  await page.getByRole("menuitem", { name: "Export" }).click();

  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download CSV/ }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^health-.*\.csv$/);

  const [json] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download JSON/ }).click(),
  ]);
  expect(json.suggestedFilename()).toMatch(/^health-.*\.json$/);
});

test("Health Reports maps Hospital reports to LexiTar diagnoses and downloads via /api/raw (W13e/W20)", async ({ page }) => {
  await unlock(page, "Alex");
  await clickNav(page, "Reports");

  // Each source is a Hospital persona bubble; its title is a plausible study type, never a filename.
  const hospital = page.locator(".persona-bubble.p-provider");
  await expect(hospital.first()).toBeVisible();
  expect(await hospital.count()).toBeGreaterThan(0);
  // M86 P3 — the title (and menu) live in the leaf-card's header row now, a sibling of the hospital
  // bubble, not nested inside it.
  const titles = await page.locator(".health-reports .leaf-card-head .cr-title").allInnerTexts();
  expect(titles.some((t) => /Echocardiogram/.test(t))).toBe(true);
  expect(titles.every((t) => !/\.(pdf|xlsx)$/i.test(t))).toBe(true);
  // The blend: at least one report is mapped to a LexiTar-diagnosis bubble alongside it.
  await expect(page.locator(".health-reports .rg-dx .persona-bubble.p-assistant").first()).toBeVisible();

  const row = page.locator(".health-reports .leaf-card").filter({ has: page.locator(".persona-bubble.p-provider") }).first();

  // Download the original via the session-cookie-gated /api/raw (W44 — no bearer header).
  await page.route("**/api/raw/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: { "content-disposition": "attachment" },
      body: "%PDF-1.4 e2e fake raw bytes",
    }),
  );
  // W46 Phase 1 — the panel is portaled to <body>, no longer a descendant of `row`.
  await openLeafMenu(row.locator(".leaf-card-head"));
  const [req, download] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/raw/${PILOTS.alex.clientId}/`)),
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download" }).click(),
  ]);
  expect(req.url()).toContain(`/api/raw/${PILOTS.alex.clientId}/`);
  expect(download.suggestedFilename().length).toBeGreaterThan(0);
});

test("Health Reports: the ✎ edit modal edits a report's title and a linked diagnosis (M66 P3)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await clickNav(page, "Reports");

  // "Echocardiogram" is an imaging report — its title IS its studyType field, so editing Study
  // type there literally edits the title shown on the bubble. Alex has more than one on record
  // (titration-style repeats), so scope to the first (most recent, sources sort newest-first).
  const row = page.locator(".leaf-card").filter({ has: page.locator(".cr-title", { hasText: "Echocardiogram" }) }).first();
  await expect(row).toBeVisible();
  const stamp = Date.now();
  const editedTitle = `Echocardiogram edited ${stamp}`;
  const editedDx = `Edited diagnosis ${stamp}`;
  // reportAnchor(s.id) is content-hash-derived, stable across an edit — capture it once up front.
  const anchorId = await row.locator(".cr-title .permalink-heading").first().getAttribute("id");

  // Scope to the leaf-card's own header row (M86 P3 — title+menu live there now, not nested inside
  // the hospital PersonaBubble) — M72 gave each diagnosis row its own Pin-only menu too, so
  // `.leaf-menu-trigger`/`.pin-slot` are still not unique within the whole leaf-card.
  await clickLeafMenuItem(row.locator(".leaf-card-head"), "Edit");
  const modal = page.locator(".modal-panel");
  await expect(modal).toHaveAttribute("aria-label", "Edit report");

  const studyTypeInput = modal.locator("label.field", { hasText: "Study type" }).locator("input");
  const originalTitle = await studyTypeInput.inputValue();
  const dxInput = modal.locator(".cr-edit-dx").first().locator("label.field", { hasText: "Diagnostic" }).locator("input");
  const originalDx = await dxInput.inputValue();

  await studyTypeInput.fill(editedTitle);
  await dxInput.fill(editedDx);
  await watchFlashes(page);
  await modal.locator(".btn.primary", { hasText: "Save" }).click();

  // M66 P4/P8 — Save fires onSaved(reportAnchor(s.id)); the page scrolls to and flashes the report's
  // own row (same anchor as before the edit — the id doesn't change).
  await expectFlashed(page, anchorId);
  await expect(page.locator(".health-reports .saved")).toBeVisible({ timeout: 10_000 });

  await expect(page.locator(".health-reports")).toContainText(editedTitle);
  await expect(page.locator(".health-reports")).toContainText(editedDx);

  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click('.roster-name:has-text("Alex")');
  await page.waitForSelector(".sidebar .nav-item");
  await clickNav(page, "Reports");
  await expect(page.locator(".health-reports")).toContainText(editedTitle);
  await expect(page.locator(".health-reports")).toContainText(editedDx);

  // Restore Alex's real record — this test must not leave committed PHI mutated.
  const editedRow = page.locator(".leaf-card").filter({ has: page.locator(".cr-title", { hasText: editedTitle }) }).first();
  await clickLeafMenuItem(editedRow.locator(".leaf-card-head"), "Edit");
  await modal.locator("label.field", { hasText: "Study type" }).locator("input").fill(originalTitle);
  await modal.locator(".cr-edit-dx").first().locator("label.field", { hasText: "Diagnostic" }).locator("input").fill(originalDx);
  await modal.locator(".btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".health-reports .saved")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".health-reports")).not.toContainText(editedTitle);
});

test("Reports delete is available to a patient session too — download and delete both present (W34/M51)", async ({ page }) => {
  await unlock(page, "Alex");
  await clickNav(page, "Reports");
  const patientReportRow = page.locator(".health-reports .leaf-card").filter({ has: page.locator(".leaf-menu-trigger") }).first();
  // W46 Phase 1 — the panel is portaled to <body>, no longer a descendant of `patientReportRow`.
  await openLeafMenu(patientReportRow.locator(".leaf-card-head"));
  await expect(page.getByRole("menuitem", { name: "Download" })).toBeVisible();
  // M51 — CRUD unified: a patient can delete their own report (the confirm() guards the cascade).
  // M66 P3/M71 — Delete is a menu item now, no longer gated behind opening ✎ first.
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});
