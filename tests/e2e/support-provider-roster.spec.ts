import { test, expect } from "./_fixtures";
import { loginAs, PILOTS, ownerSignOut } from "./_login";

// W50 — support→provider roster access, end to end and re-runnable (cleans up the grant it creates):
// the support agent requests access to the provider (fam4) by email; the provider logs in, sees the
// pending request on the roster, and approves it; support then sees the provider under "Providers",
// opens its roster, and finds the provider's patients present but NOT openable (no per-patient consent);
// finally the provider revokes the grant so the next run starts clean.
test("support requests a provider's roster, provider approves, support views it (records gated)", async ({ page }) => {
  // 1) support console → request access to the provider by email.
  await loginAs(page, PILOTS.support.email, "support");
  await expect(page.locator(".account-trigger")).toBeVisible();
  await page.fill(".access-add input", PILOTS.provider.email);
  await page.click('.access-add button:has-text("Request access")');
  await expect(page.locator(".access-add input")).toHaveValue(""); // request settled
  await ownerSignOut(page);

  // 2) provider logs in → the roster shows the pending support request → approve.
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  const pending = page.locator(".access-pending", { hasText: "Support access requests" });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(PILOTS.support.name);
  await pending.locator(".access-approve").click();
  const granted = page.locator(".access-pending", { hasText: "Support agents with roster access" });
  await expect(granted).toContainText(PILOTS.support.name);
  await ownerSignOut(page);

  // 3) support logs in → provider appears under Providers → open roster → patients present, not openable.
  await loginAs(page, PILOTS.support.email, "support");
  await page.click('.roster-name:has-text("Family Provider")');
  await expect(page.locator(".sub")).toContainText("Roster of");
  await expect(page.locator(".roster-name-disabled").first()).toBeVisible(); // record not openable (no patient consent)
  await ownerSignOut(page);

  // 4) cleanup — provider revokes the grant so the test is re-runnable.
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  await page.locator(".access-pending", { hasText: "Support agents with roster access" }).locator(".access-revoke").click();
  await expect(page.locator(".access-pending", { hasText: "Support agents with roster access" })).toHaveCount(0);
});
