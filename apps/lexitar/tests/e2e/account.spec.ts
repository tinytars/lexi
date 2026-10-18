import { test, expect } from "./_fixtures";
import { loginAs, signUp, openOwnerAccount, ownerSignOut } from "./_login";
import { E2E_CLINICIAN } from "./_synthetic";

// W44 P8 — the owner Account modal. Uses a FRESH signed-up account (unique email) so editing the
// profile doesn't rename an account another spec depends on.
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
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await page.waitForSelector(".roster-list"); // provider lands on the roster
  await expect(page.locator(".account-trigger")).toBeVisible();
  await page.click(".account-trigger");
  await expect(page.locator('.menu-item:has-text("Account settings")')).toBeVisible();
  await expect(page.locator('.menu-item:has-text("Who can access")')).toHaveCount(0);
});

// DPGA 7.5 / 9A — the deletion the route has always allowed and nothing could reach. Uses a throwaway
// account created in this test: it really is deleted.
test("owner deletes their own account and is told what was removed", async ({ page }) => {
  const email = `e2e-erase-${Date.now()}@local.invalid`;
  await signUp(page, email);
  await openOwnerAccount(page);

  const modal = page.locator(".access-panel");
  await expect(modal).toContainText("Delete this account");

  // Two steps: arm, then echo your own email. Arming alone deletes nothing.
  await modal.locator('button:has-text("Delete this account")').click();
  const confirm = modal.locator('input[aria-label="Confirm your email address"]');
  await expect(confirm).toBeVisible();

  // The wrong address is refused by the route, and the account survives it.
  await confirm.fill("someone-else@local.invalid");
  await modal.locator('button:has-text("Delete everything")').click();
  await expect(page.locator(".access-error")).toContainText(/confirm/i);

  await confirm.fill(email);
  await modal.locator('button:has-text("Delete everything")').click();

  // Signed out, with the report — the only place the count is ever stated, since the modal it was
  // asked for in is gone with the account.
  await expect(page.locator(".verify-banner.erase-report")).toContainText(/Deleted/);
  // Scoped to the sign-in screen: the panel's own disabled confirm field can still be in the DOM for
  // a frame after sign-out, and an unscoped input[type="email"] then matches two elements.
  const signIn = page.locator("main.lock");
  await expect(signIn.locator('input[type="email"]')).toBeVisible();

  // And the account really is gone: the same password no longer signs in.
  await signIn.locator('input[type="email"]').fill(email);
  await signIn.locator('input[type="password"]').fill("e2e-pass-123");
  await signIn.locator('button[type="submit"]').click();
  await expect(signIn.locator('input[type="email"]')).toBeVisible();
});

// The arm step is component-local state that signOut() did not clear, so it survived a sign-out:
// the next sign-in on the same page load reopened Account already primed to delete, with the
// previous account's address still in the field. Signs back in through the lock screen rather than
// loginAs(), which navigates — a reload would clear the state whether or not signOut does.
test("the delete-account step does not stay armed across a sign out", async ({ page }) => {
  const email = `e2e-erase-arm-${Date.now()}@local.invalid`;
  await signUp(page, email);
  await openOwnerAccount(page);

  const modal = page.locator(".access-panel");
  const confirm = modal.locator('input[aria-label="Confirm your email address"]');
  await modal.locator('button:has-text("Delete this account")').click();
  await expect(confirm).toBeVisible();

  await page.click('.modal-close[aria-label="Close"]');
  await ownerSignOut(page);

  const signIn = page.locator("main.lock");
  await signIn.locator('input[type="email"]').fill(email);
  await signIn.locator('input[type="password"]').fill("e2e-pass-123");
  await signIn.locator('button[type="submit"]').click();
  await expect(page.locator(".account-trigger")).toBeVisible();

  await openOwnerAccount(page);
  await expect(confirm).toHaveCount(0);
  await expect(modal.locator('button:has-text("Delete this account")')).toBeVisible();
});
