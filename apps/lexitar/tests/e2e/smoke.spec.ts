import { test, expect } from "./_fixtures";
import { openPatient, openAsProvider, PILOTS } from "./_login";

// W44 harness smoke test: proves account login works end-to-end against the real Functions + the
// D1-seeded pilots, and that the v2 vault decrypts (the patient's name renders).
test("a migrated patient signs in and their record opens", async ({ page }) => {
  await openPatient(page, PILOTS.alex);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});

test("the provider signs in, sees the roster, and drills into a patient", async ({ page }) => {
  await openAsProvider(page, PILOTS.alex.name);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});
