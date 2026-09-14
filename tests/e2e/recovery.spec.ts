import { test, expect } from "./_fixtures";
import { signUp, ownerSignOut, openOwnerAccount, loginAs } from "./_login";

// W44 P8b / W48 — recover with a recovery code. Signup no longer shows one (W48), so the user first
// generates it from the Account menu, then signs out and uses "Forgot password?" to get back in.
test("a user generates a recovery code and recovers with it", async ({ page }) => {
  const email = `e2e-recover-${Date.now()}@local.invalid`;
  await signUp(page, email);

  // Obtain the recovery code from Account → Generate.
  await openOwnerAccount(page);
  await page.click('button:has-text("Generate recovery code")');
  const code = (await page.locator(".recovery-code").innerText()).trim();
  expect(code.length).toBeGreaterThan(8);
  await page.click('.modal-close[aria-label="Close"]');

  await ownerSignOut(page);

  await page.click('button:has-text("Forgot password")');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="text"]', code);
  // W73 — a new password is part of redeeming the code, not a later step, and the button stays
  // disabled without one. Before this, redemption signed you in and left the FORGOTTEN password in
  // place, so the next sign-in put you straight back on this screen having spent the code.
  await page.fill('input[type="password"]', "e2e-recovered-456");
  await page.click('button:has-text("Recover")');

  // Back in — the owner account menu is present.
  await expect(page.locator(".account-trigger")).toBeVisible();

  // The assertion the old test could not make: the password set during recovery actually works. A
  // check that stopped at "signed in" passed for the whole time this flow was a dead end.
  await ownerSignOut(page);
  await loginAs(page, email, "e2e-recovered-456");
  await expect(page.locator(".account-trigger")).toBeVisible();
});
