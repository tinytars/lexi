// W76 — deliberately NOT on ./_fixtures. This spec asserts that a FRESH login still opens the
// patient's record after an access mutation that re-keys the vault. Capture-and-replay would answer
// that from the browser's own captured bytes, so it would keep passing while proving nothing — which
// is exactly what it did before this exclusion. Safe un-intercepted: these flows run on fresh
// signups, whose vaults are far too small to be caught mid-stream by the wrangler crash.
import { test, expect } from "@playwright/test";
import { PILOTS, signUp, openOwnerAccess, loginAs, ownerSignOut } from "./_login";

// W44 P4 — owner-side Access panel: a patient grants then revokes a provider. Uses a FRESH signed-up
// account (unique email per run) so the grant/revoke is additive to the shared seed — it links the
// existing fam4 clinician to the new patient and removes it again, never touching fam4↔pilot links.
test("owner grants then revokes a provider via the Access panel", async ({ page }) => {
  await signUp(page, `e2e-grant-${Date.now()}@local.invalid`);

  await openOwnerAccess(page);

  // A brand-new account has no providers.
  await expect(page.locator(".access-empty")).toBeVisible();

  // Grant the existing fam4 clinician by email → it appears in the list.
  await page.fill(".access-add input", PILOTS.provider.email);
  await page.click('.access-add button:has-text("Add provider")');
  await expect(page.locator(".access-list li")).toHaveCount(1);

  // Revoke → back to empty.
  await page.click(".access-revoke");
  await expect(page.locator(".access-empty")).toBeVisible();
});

// The Access affordance is owner-only: a provider (fam4) drilled into a pilot has an account menu
// (W48) but it must not offer record-sharing — "Who can access my record" is patient-only.
test("the Access item is absent from a provider's account menu", async ({ page }) => {
  await page.goto("/");
  await page.fill('input[type="email"]', PILOTS.provider.email);
  await page.fill('input[type="password"]', PILOTS.provider.password);
  await page.click('button[type="submit"]');
  await page.click(`.roster-name:has-text("${PILOTS.alex.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  await page.click(".account-trigger");
  await expect(page.locator('.menu-item:has-text("Who can access")')).toHaveCount(0);
});

// W48 — a provider drops a patient from their OWN roster (gives up their access); the patient's
// record is untouched. Fresh patient grants fam4, fam4 removes them, patient still owns their vault.
test("a provider removes a patient from their own roster", async ({ page }) => {
  const ts = Date.now();
  const patientEmail = `e2e-provrm-${ts}@local.invalid`;
  const slug = `e2e-provrm-${ts}`; // account displayName = email local part (doSignup)
  const pw = "e2e-pass-123";

  await signUp(page, patientEmail, pw);
  await openOwnerAccess(page);
  await page.fill(".access-add input", PILOTS.provider.email);
  await page.click('.access-add button:has-text("Add provider")');
  await expect(page.locator(".access-list li")).toHaveCount(1);
  await page.click('.modal-close[aria-label="Close"]').catch(() => {});
  await ownerSignOut(page);

  page.on("dialog", (d) => d.accept()); // the Remove confirm()
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  await page.waitForSelector(".roster-list");
  await expect(page.locator(`.roster-name:has-text("${slug}")`)).toBeVisible();
  await page.locator(`.roster-list li:has(.roster-name:has-text("${slug}")) .roster-remove`).click();
  await expect(page.locator(`.roster-name:has-text("${slug}")`)).toHaveCount(0);

  // The patient still owns their record.
  await ownerSignOut(page);
  await loginAs(page, patientEmail, pw);
  await expect(page.locator(".account-trigger")).toBeVisible();
});
