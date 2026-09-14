import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openPatient, loginAs, PILOTS } from "./_login";

// W40 Phase 2 — the compliance footer (501(c)(3)/EIN + legal links) renders on every state via the
// shared shell: the lock screen (pre-unlock) and the authenticated app.

async function expectChrome(page: Page) {
  const footer = page.locator("footer.tt-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("501(c)(3)");
  await expect(footer).toContainText("EIN: 39-2278196");
  await expect(footer.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
    "href",
    /tinytars\.foundation\/privacy$/,
  );
  await expect(footer.getByRole("link", { name: "Non-discrimination" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "Terms of Service" })).toBeVisible();

  // W40 Phase 3 — the persistent medical disclaimer + privacy statement, verbatim from tinytars.
  const disclaimer = page.locator("section.disclaimer");
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText(
    "does not provide medical advice, professional diagnostics, symptom triage, or treatment recommendations",
  );
  await expect(disclaimer).toContainText("we never sell, rent, or monetize your personal or health data");
}

test("footer renders on the lock screen (before unlock)", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("main.lock")).toBeVisible();
  await expectChrome(page);
});

test("footer renders on the provider roster screen", async ({ page }) => {
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  await expect(page.locator("main.roster")).toBeVisible();
  await expectChrome(page);
});

test("footer renders in the authenticated app", async ({ page }) => {
  await openPatient(page);
  await expectChrome(page);
});
