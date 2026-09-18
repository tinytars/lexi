// W80 — deliberately NOT on ./_fixtures, for the same reason as providers-access.spec.ts: this test
// grants a provider access (which re-keys the vault) and then asserts that the code the provider
// issues actually redeems against the real server — capture-and-replay would answer that from bytes
// this run itself produced, proving nothing about whether auto-detection reached the real endpoint.
// Safe un-intercepted: it runs on a fresh signup, whose vault is far too small to catch mid-stream.
import { test, expect } from "@playwright/test";
import { signUp, openOwnerAccess, ownerSignOut, loginAs } from "./_login";
import { E2E_CLINICIAN } from "./_synthetic";

// Before W80 the lock screen made a patient pick "I have my own code" vs. "I don't" before it would
// even show the right field — a provider-issued grant code pasted into the self-service sub-form
// failed as an ordinary wrong-code 401, indistinguishable from a typo. This is the rung-2 case the
// old toggle covered by hand: prove a grant code is now routed correctly with no button click at all.
test("a provider-issued grant code is auto-detected and redeems at rung 2", async ({ page }) => {
  const ts = Date.now();
  const patientEmail = `e2e-grantdetect-${ts}@local.invalid`;
  const slug = `e2e-grantdetect-${ts}`; // account displayName = email local part (doSignup)

  await signUp(page, patientEmail);
  await openOwnerAccess(page);
  await page.fill(".access-add input", E2E_CLINICIAN.email);
  await page.click('.access-add button:has-text("Add provider")');
  await expect(page.locator(".access-list li")).toHaveCount(1);
  await page.click('.modal-close[aria-label="Close"]').catch(() => {});
  await ownerSignOut(page);

  // Issue the grant code from the provider's roster.
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await page.waitForSelector(".roster-list");
  const row = page.locator(`.roster-list li:has(.roster-name:has-text("${slug}"))`);
  await row.locator(".roster-recover").click();
  const code = (await page.locator(".rc-code").innerText()).trim();
  expect(code).toMatch(/^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/);
  await page.click('.modal-close[aria-label="Close"]');
  await ownerSignOut(page);

  // The patient pastes it into the ONE recovery field — no toggle to press first.
  await page.click('button:has-text("Forgot password")');
  await page.fill('input[type="email"]', patientEmail);
  await page.fill('input[type="text"]', code);
  // Auto-detected as rung 2 purely from the code's shape: the destructive note is what discloses the
  // rung now that there is no manual pick to disclose at, and it must show BEFORE Recover is pressed.
  await expect(page.locator(".lock-note")).toContainText("will all stop working");
  await page.fill('input[type="password"]', "e2e-grant-redeemed-789");
  await page.click('button:has-text("Recover")');

  await expect(page.locator(".account-trigger")).toBeVisible();

  // The password set during redemption actually works — a check that stopped at "signed in" would
  // pass even if the new keypair were never actually wired to the new password credential.
  await ownerSignOut(page);
  await loginAs(page, patientEmail, "e2e-grant-redeemed-789");
  await expect(page.locator(".account-trigger")).toBeVisible();
});
