import { test, expect } from "./_fixtures";
import { openAsProvider, hashOf } from "./_login";
import { clickNav, clickProfileSub } from "./_nav";
import { clickLeafMenuItem } from "./_leaf-menu";
import { search } from "./_search";

// Split out of search.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd partway through a long
// spec, and `--shard` partitions by FILE, so one oversized file sets the floor for every slice.
// This half: the free-text leaf kinds — notes, reports, allergies, family history, study,
// glossary, doctor questions.

test("sidebar search finds a note by its text and navigates to it (M85)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M85 search note ${Date.now()}`;
  await openAsProvider(page, "Pablo");

  await clickNav(page, "Notes");
  await page.waitForSelector(".notes", { timeout: 10_000 });
  await page.getByTitle("Add note").click();
  await page.locator(".nt-modal .note-input").fill(marker);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Notes" })).toBeVisible();
  const searchRow = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(searchRow, "Open");

  // Anchor scroll/flash is app-internal state (App.svelte's resolveAnchor), never written into the
  // URL hash (see App.svelte's hash-sync effect: "Anchor is never written here") — so the
  // navigation is confirmed via the flash highlight, not the URL.
  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/notes$`));
  await expect(page.locator(".notes .permalink-flash")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".notes")).toContainText(marker);

  // Real, unmocked write to the shared vault — clean up so later e2e files (shell-treatment.spec.ts's
  // staleness-node tests) don't start from an unexpectedly-stale patientAssessment.
  const row = page.locator(".notes .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, /Delete/);
  await expect(page.locator(".notes")).not.toContainText(marker);
});

test("sidebar search finds a clinical report by its title (M85)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await search(page, "Echocardiogram");
  await expect(page.locator(".search-results .search-group", { hasText: "Reports" })).toBeVisible();
  const reportRow = page.locator(".search-results .leaf-card", { hasText: "Echocardiogram" }).first();
  await clickLeafMenuItem(reportRow, "Open");
  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/healthReports`));
});

test("sidebar search finds an allergy by its text (M85)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M85 search allergen ${Date.now()}`;
  await openAsProvider(page, "Pablo");
  await clickProfileSub(page, "Allergies");
  await page.waitForSelector(".allergies", { timeout: 10_000 });
  await page.locator('.side-row-action[aria-label="Add allergy"]').click();
  await page.locator(".az-modal input[type=text]").first().fill(marker);
  await page.locator(".az-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".allergies .saved")).toBeVisible({ timeout: 10_000 });

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Allergies" })).toBeVisible();
  const searchRow = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(searchRow, "Open");
  await expect(page.locator(".allergies .permalink-flash")).toBeVisible({ timeout: 5_000 });

  // Real, unmocked write to the shared vault — clean up (see notes test above).
  const row = page.locator(".allergies .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, /Delete/);
  await expect(page.locator(".allergies")).not.toContainText(marker);
});

test("sidebar search finds a family history entry by its text (M85)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M85 search relative ${Date.now()}`;
  await openAsProvider(page, "Pablo");
  await clickProfileSub(page, "Family");
  await page.waitForSelector(".family", { timeout: 10_000 });
  await page.locator('.side-row-action[aria-label="Add family history"]').click();
  await page.locator(".fh-modal input[type=text]").first().fill(marker);
  await page.locator(".fh-modal input[type=text]").nth(1).fill("Note");
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".family .saved")).toBeVisible({ timeout: 10_000 });

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Family" })).toBeVisible();
  const searchRow = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(searchRow, "Open");
  await expect(page.locator(".family .permalink-flash")).toBeVisible({ timeout: 5_000 });

  // Real, unmocked write to the shared vault — clean up (see notes test above).
  const row = page.locator(".family .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, /Delete/);
  await expect(page.locator(".family")).not.toContainText(marker);
});

test("sidebar search finds a study topic by its text (M85)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openAsProvider(page, "Pablo");
  const marker = `M85 search topic ${Date.now()}`;
  await clickNav(page, "Study");
  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .leaf-card", { hasText: marker })).toBeVisible({ timeout: 10_000 });

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Study" })).toBeVisible();
  const row = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(row, "Open");
  await expect(page.locator(".study .permalink-flash")).toBeVisible({ timeout: 5_000 });

  // Real, unmocked write to the shared vault — clean up (see notes test above).
  const cleanupRow = page.locator(".study .leaf-card", { hasText: marker });
  await clickLeafMenuItem(cleanupRow, /Delete/);
  await expect(page.locator(".study")).not.toContainText(marker);
});

test("sidebar search finds a glossary term (M85)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await search(page, "ApoB");
  const group = page.locator(".search-results .search-group", { hasText: "Glossary" });
  await expect(group).toBeVisible();
  // W62 — a glossary hit is a turn CELL now, not a lone bubble, so it is `.leaf-card` like every
  // other result. Scoped to its own group: `.leaf-card` is no longer unique to one section's
  // results, and an unscoped .first() can land on a different group's card entirely.
  const cell = group.locator(".leaf-card", { hasText: "ApoB" }).first();
  await clickLeafMenuItem(cell, "Open");
  await expect(page.locator(".glossary .permalink-flash")).toBeVisible({ timeout: 5_000 });
});

test("sidebar search finds a doctor question (M85)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await search(page, "FibroScan");
  const group = page.locator(".search-results .search-group", { hasText: "Questions" });
  await expect(group).toBeVisible();
  const cell = group.locator(".leaf-card", { hasText: "FibroScan" }).first();
  await clickLeafMenuItem(cell, "Open");
  await expect(page.locator(".questions-dr .permalink-flash")).toBeVisible({ timeout: 5_000 });
});
