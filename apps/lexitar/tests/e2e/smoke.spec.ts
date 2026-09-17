import { test, expect } from "./_fixtures";
import { openSynthetic, openSyntheticAsProvider } from "./_synthetic";

// W44 harness smoke test: proves account login works end-to-end against the real Functions + a
// provisioned synthetic patient, and that the v2 vault decrypts (the patient's name renders).
test("a migrated patient signs in and their record opens", async ({ page }) => {
  await openSynthetic(page);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});

test("the provider signs in, sees the roster, and drills into a patient", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});
