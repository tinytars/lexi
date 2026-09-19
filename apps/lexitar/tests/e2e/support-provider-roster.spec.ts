import { test, expect } from "./_fixtures";
import { loginAs, ownerSignOut } from "./_login";
import { E2E_CLINICIAN, E2E_SUPPORT, revokeClinicianLinks } from "./_synthetic";

test.afterEach(({ page }) => revokeClinicianLinks(page, "providers", E2E_SUPPORT.name));

test("support requests a provider's roster, provider approves, support views it (records gated), provider revokes", async ({ page }) => {
  // 1) support console → request access to the provider by email.
  await loginAs(page, E2E_SUPPORT.email, E2E_SUPPORT.password);
  await expect(page.locator(".account-trigger")).toBeVisible();
  await page.fill(".access-add input", E2E_CLINICIAN.email);
  await page.click('.access-add button:has-text("Request access")');
  await expect(page.locator(".access-add input")).toHaveValue(""); // request settled
  await ownerSignOut(page);

  // 2) provider logs in → the roster shows the pending support request → approve.
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  const pending = page.locator(".access-pending", { hasText: "Support access requests" });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(E2E_SUPPORT.name);
  await pending.locator(".access-approve").click();
  const granted = page.locator(".access-pending", { hasText: "Support agents with roster access" });
  await expect(granted).toContainText(E2E_SUPPORT.name);
  await ownerSignOut(page);

  // 3) support logs in → provider appears under Providers → open roster → patients present, not openable.
  await loginAs(page, E2E_SUPPORT.email, E2E_SUPPORT.password);
  await page.click('.roster-name:has-text("E2E Clinician")');
  await expect(page.locator(".sub")).toContainText("Roster of");
  await expect(page.locator(".roster-name-disabled").first()).toBeVisible(); // record not openable (no patient consent)
  await ownerSignOut(page);

  // 4) provider revokes the grant.
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await page.locator(".access-pending", { hasText: "Support agents with roster access" }).locator(".access-revoke").click();
  await expect(page.locator(".access-pending", { hasText: "Support agents with roster access" })).toHaveCount(0);
});
