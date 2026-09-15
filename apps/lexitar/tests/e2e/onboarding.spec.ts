import { test, expect } from "./_fixtures";
import { signUpRaw } from "./_login";

// W46 — a brand-new account (empty vault) must land on a self-service onboarding screen, not the
// old "Select a patient above" dead-end, and be able to create a first record + reach Import.
test("new user lands on onboarding, creates a record, and is taken to Import", async ({ page }) => {
  await signUpRaw(page, `e2e-onboard-${Date.now()}@local.invalid`);

  // The onboarding screen — not the app shell, not the dead-end fallback.
  await expect(page.locator(".onboard")).toBeVisible();
  await expect(page.locator(".onboard input[type='number']")).toBeVisible(); // birth-year ask
  await expect(page.locator(".needs-client")).toHaveCount(0);
  await expect(page.locator(".account-trigger")).toHaveCount(0); // app shell not reached yet

  // W47 — the onboarding asks only birth year + sex (no name). Provide a year and Continue.
  await page.fill(".onboard input[type='number']", "1980");
  await page.click(".onboard button.primary");

  // createFirstClient auto-opens the Import modal.
  await expect(page.locator("button.modal-close")).toBeVisible();
  await expect(page.getByRole("heading", { name: /import a report/i })).toBeVisible();

  // Closing it reveals the real app shell (owner account menu present) with the new patient selected.
  await page.click("button.modal-close");
  await expect(page.locator(".account-trigger")).toBeVisible();
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});

// W47 — Skip still creates a minimal patient (no birth year/sex), so the user lands in a usable app
// rather than the empty-vault dead-end.
test("new user can skip the profile and still reach the app", async ({ page }) => {
  await signUpRaw(page, `e2e-onboard-skip-${Date.now()}@local.invalid`);
  await expect(page.locator(".onboard")).toBeVisible();

  await page.click('.onboard button.link:has-text("Skip")');

  // Skip still mints a patient → Import modal opens; closing it reveals the app shell.
  await expect(page.locator("button.modal-close")).toBeVisible();
  await page.click("button.modal-close");
  await expect(page.locator(".account-trigger")).toBeVisible();
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
});
