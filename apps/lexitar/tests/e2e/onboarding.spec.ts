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

// 9C.3 — Skip used to create a minimal patient with no birth year, which made the 16+ limit one
// click wide: no year meant nothing to check. Skip now declines to skip the one field the limit
// needs, and says so on the screen.
test("Skip is refused because the birth year is required", async ({ page }) => {
  await signUpRaw(page, `e2e-onboard-skip-${Date.now()}@local.invalid`);
  await expect(page.locator(".onboard")).toBeVisible();

  await page.click('.onboard button.link:has-text("Skip")');

  await expect(page.locator(".onboard p.err")).toContainText(/birth year is required/i);
  // Still on onboarding: no patient was minted and Import never opened.
  await expect(page.locator(".onboard")).toBeVisible();
  await expect(page.locator("button.modal-close")).toHaveCount(0);
});

// 9C.3 — the refusal an assessor checks first: a birth year that makes the user under 16.
test("an underage birth year is refused with a readable message", async ({ page }) => {
  await signUpRaw(page, `e2e-onboard-underage-${Date.now()}@local.invalid`);
  await expect(page.locator(".onboard")).toBeVisible();

  await page.fill(".onboard input[type='number']", String(new Date().getFullYear() - 10));
  await page.click(".onboard button.primary");

  await expect(page.locator(".onboard p.err")).toContainText(/aged 16 and over/i);
  await expect(page.locator("button.modal-close")).toHaveCount(0);

  // The same screen accepts a year that passes, so the refusal is the gate and not a dead end.
  await page.fill(".onboard input[type='number']", "1980");
  await page.click(".onboard button.primary");
  await expect(page.locator("button.modal-close")).toBeVisible();
});
