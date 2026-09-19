import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./_login";
import { E2E_CLINICIAN, openSynthetic } from "./_synthetic";

// Content lives in tests/unit/footer.test.ts; this proves the shared shell mounts it on every screen.
async function expectChrome(page: Page) {
  await expect(page.locator("footer.tt-footer")).toBeVisible();
  await expect(page.locator("section.disclaimer")).toBeVisible();
}

test("footer renders on the lock screen (before unlock)", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("main.lock")).toBeVisible();
  await expectChrome(page);
});

test("footer renders on the provider roster screen", async ({ page }) => {
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await expect(page.locator("main.roster")).toBeVisible();
  await expectChrome(page);
});

test("footer renders in the authenticated app", async ({ page }) => {
  await openSynthetic(page);
  await expectChrome(page);
});
