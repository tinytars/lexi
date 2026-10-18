// W76 — deliberately NOT on ./_fixtures. This spec asserts that a FRESH login still opens the
// patient's record after an access mutation that re-keys the vault. Capture-and-replay would answer
// that from the browser's own captured bytes, so it would keep passing while proving nothing — which
// is exactly what it did before this exclusion. Safe un-intercepted: these flows run on fresh
// signups, whose vaults are far too small to be caught mid-stream by the wrangler crash.
import { test, expect } from "@playwright/test";
import { loginAs, signUp, ownerSignOut, openOwnerAccess } from "./_login";
import { E2E_SUPPORT } from "./_synthetic";

// W44 P4b — support consented access, end to end and SELF-CONTAINED (idempotent, re-runnable): a fresh
// patient signs up; the seeded support agent logs in and requests access to them; the patient logs back
// in, sees the pending request, and approves it. Each run uses a new patient, so nothing is consumed
// from shared seed state.
test("support requests access and the patient approves it", async ({ page }) => {
  const patientEmail = `e2e-support-pat-${Date.now()}@local.invalid`;
  const pw = "e2e-pass-123";

  // 1) fresh patient account, then sign out.
  await signUp(page, patientEmail, pw);
  await ownerSignOut(page);

  // 2) support agent logs in → support console → request access to the patient by email.
  await loginAs(page, E2E_SUPPORT.email, E2E_SUPPORT.password);
  await page.fill(".access-add input", patientEmail);
  await page.click('.access-add button:has-text("Request access")');
  await expect(page.locator(".access-add input")).toHaveValue(""); // request POST settled (field clears)
  // W50 — the request is now visibly pending on the requester (support) side.
  await expect(page.locator(".access-subhead", { hasText: "Pending requests" })).toBeVisible();
  await ownerSignOut(page); // W48 — support console now signs out via the account menu

  // 3) patient logs back in → Access shows the pending support request → approve.
  await loginAs(page, patientEmail, pw);
  await expect(page.locator(".account-trigger")).toBeVisible();
  await openOwnerAccess(page);
  const pending = page.locator(".access-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(E2E_SUPPORT.name);
  await pending.locator(".access-approve").click();

  // approved → moves out of pending into active access.
  await expect(page.locator(".access-pending")).toHaveCount(0);
  await expect(page.locator(".access-list")).toContainText(E2E_SUPPORT.name);

  // W44 P4c — revoking active support re-keys the vault (client rotation). It must succeed with no error,
  // the support must disappear, and — the real test — the patient must still open their record from a
  // FRESH login (the new blob decrypts via the re-wrapped owner envelope).
  await page.locator(".access-list .access-revoke").click();
  await expect(page.locator(".access-error")).toHaveCount(0);
  await expect(page.locator(".access-empty")).toBeVisible(); // support gone

  await page.click(".modal-close[aria-label=\"Close\"]").catch(() => {});
  await ownerSignOut(page);
  await loginAs(page, patientEmail, pw);
  await expect(page.locator(".account-trigger")).toBeVisible(); // rotated vault opens
});
