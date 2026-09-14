import { test, expect } from "./_fixtures";
import { PILOTS, signUp, openOwnerAccount } from "./_login";

// W44 P8 — the owner Account modal. Uses a FRESH signed-up account (unique email) so editing the
// profile doesn't rename a shared pilot other specs depend on.
test("owner edits profile and sees sign-in methods in Account", async ({ page }) => {
  await signUp(page, `e2e-account-${Date.now()}@local.invalid`);

  // W47 — a fresh password account is unverified, so the non-blocking verify banner shows.
  // (W48 adds a separate .recovery-nudge banner with the same base class, so exclude it.)
  await expect(page.locator(".verify-banner.warn:not(.recovery-nudge)")).toBeVisible();

  await openOwnerAccount(page);
  const modal = page.locator(".access-panel");
  await expect(modal).toBeVisible();
  // A password-signup account lists exactly the Password method (with an Add-a-passkey affordance).
  // (W55 P4 adds a second .access-list — the recovery-key access log — so exclude it.)
  await expect(modal.locator(".access-list:not(.access-events)")).toContainText("Password");

  // openAccount() renders the modal before its getMyAccount() resolves, then assigns editDisplayName —
  // which would clobber a value typed too early. Wait for the field to be populated before editing.
  const nameInput = page.locator('.account-profile input[type="text"]');
  await expect(nameInput).not.toHaveValue("");
  await nameInput.fill("Renamed Owner");
  const saveBtn = page.locator('.account-profile button:has-text("Save profile")');
  // Wait for the profile PATCH to be acked before closing — `toBeEnabled()` raced it (the button is
  // enabled both before and during the brief accountBusy window), so the reopen could read a stale name.
  const patched = page.waitForResponse((r) => r.url().includes("/api/account") && r.request().method() === "PATCH" && r.ok());
  await saveBtn.click();
  await patched;

  await page.click('.modal-close[aria-label="Close"]');
  await openOwnerAccount(page); // reopen → re-fetches from the server
  await expect(page.locator('.account-profile input[type="text"]')).toHaveValue("Renamed Owner");
});

// W48 — a provider now has an account menu (on the roster), but it must NOT offer record-sharing
// (they don't own a record). The menu shows Account settings + Sign out, no "Who can access".
test("provider account menu is present but omits the record-sharing item", async ({ page }) => {
  await page.goto("/");
  await page.fill('input[type="email"]', PILOTS.provider.email);
  await page.fill('input[type="password"]', PILOTS.provider.password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".roster-list"); // provider lands on the roster
  await expect(page.locator(".account-trigger")).toBeVisible();
  await page.click(".account-trigger");
  await expect(page.locator('.menu-item:has-text("Account settings")')).toBeVisible();
  await expect(page.locator('.menu-item:has-text("Who can access")')).toHaveCount(0);
});
