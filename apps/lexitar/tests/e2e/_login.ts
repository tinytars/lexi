import { expect, type Page } from "@playwright/test";

// W44 — shared account-login helpers for the e2e suite (replaces the per-spec passphrase-unlock
// copies). Runs against the real /api/auth/* Functions via wrangler pages dev.

export async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

// W44 — robust fresh-account signup for e2e (the shared flake source). Creates a new password account,
// captures the one-time recovery code, acknowledges it. Every step web-first-waits so it's stable under
// the pre-push hook's load. Leaves the page on the W46 onboarding screen (fresh vault = 0 patients).
// Returns the recovery code. Use a unique email per test to stay non-contaminating.
export async function signUpRaw(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await page.goto("/");
  await page.click('button:has-text("Create an account")'); // toggle to signup mode
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // W48 — signup enters directly (no recovery-code screen); a fresh account lands on onboarding.
  await page.locator(".onboard").waitFor({ state: "visible", timeout: 40000 });
}

// W46/W47 — a fresh account lands on the onboarding screen (empty vault). It asks only birth year + sex
// (no name); provide a year and Continue, then dismiss the Import modal createFirstClient auto-opens.
export async function completeOnboarding(page: Page): Promise<void> {
  await page.fill(".onboard input[type='number']", "1980");
  await page.click(".onboard button.primary"); // "Continue"
  const modalClose = page.locator("button.modal-close");
  await expect(modalClose).toBeVisible();
  await modalClose.click(); // close the auto-opened Import modal
}

// Full signup → onboarding → app shell. W47 — the owner shell no longer has a flat Sign-out button; the
// top-right account menu (.account-trigger) is the tell.
export async function signUp(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await signUpRaw(page, email, password);
  await completeOnboarding(page);
  await expect(page.locator(".account-trigger")).toBeVisible();
}

// W47 — owner account-menu interactions (the menu replaced the flat Account/Access/Sign out buttons).
export async function ownerSignOut(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Sign out")');
}
export async function openOwnerAccount(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Account settings")');
}
export async function openOwnerAccess(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Who can access")');
}
