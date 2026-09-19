import { expect, type Page } from "@playwright/test";

export async function loginAs(page: Page, email: string, password: string, path = "/") {
  await page.goto(path);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

// A fresh account lands on onboarding (empty vault); use a unique email per test.
export async function signUpRaw(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await page.goto("/");
  await page.click('button:has-text("Create an account")');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.locator(".onboard").waitFor({ state: "visible", timeout: 40000 });
}

// Onboarding auto-opens the Import modal after Continue, so dismiss it.
export async function completeOnboarding(page: Page): Promise<void> {
  await page.fill(".onboard input[type='number']", "1980");
  await page.click(".onboard button.primary");
  const modalClose = page.locator("button.modal-close");
  await expect(modalClose).toBeVisible();
  await modalClose.click();
}

export async function signUp(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await signUpRaw(page, email, password);
  await completeOnboarding(page);
  await expect(page.locator(".account-trigger")).toBeVisible();
}

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
