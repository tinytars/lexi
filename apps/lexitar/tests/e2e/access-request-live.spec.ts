// The same badge as access-request-badge.spec.ts, on the real path. That spec routes `**/api/providers`
// to a literal, so it proves the rendering and nothing about the fetch — and the fetch is what failed
// in production: the owner the badge was built for still saw nothing after it shipped, because
// `refreshQuietly` swallowed every error and an unreachable list looked exactly like an empty one.
// Nothing here is stubbed, so this fails if the load never runs, 4xx's, 5xx's, or throws.
//
// Not on ./_fixtures, for the reason providers-support.spec.ts gives: capture-and-replay would answer
// the GET from the browser's own captured bytes and keep passing while proving nothing.
import { test, expect } from "@playwright/test";
import { loginAs, signUp, ownerSignOut } from "./_login";
import { E2E_SUPPORT } from "./_synthetic";

// One flow rather than two: seeding a real pending request costs a signup, a support login and a
// re-login, and "the badge appears" and "the badge clears" are the two halves of one count.
test("a real pending request raises the sidebar badge, and approving it clears the badge", async ({ page }) => {
  const patientEmail = `e2e-badge-pat-${Date.now()}@local.invalid`;
  const pw = "e2e-pass-123";

  await signUp(page, patientEmail, pw);
  await ownerSignOut(page);

  await loginAs(page, E2E_SUPPORT.email, E2E_SUPPORT.password);
  await page.fill(".access-add input", patientEmail);
  await page.click('.access-add button:has-text("Request access")');
  await expect(page.locator(".access-add input")).toHaveValue(""); // the POST settled
  await ownerSignOut(page);

  // The owner comes back and is TOLD, without opening anything — the assertion the shipped build
  // passed against a stub and failed against the deployment.
  await loginAs(page, patientEmail, pw);
  const badge = page.locator('[data-testid="access-request-badge"]');
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).toHaveText(/1 request to read your record/i);

  await badge.click();
  const pending = page.locator(".access-panel .access-pending");
  await expect(pending).toContainText(E2E_SUPPORT.name);
  await pending.locator(".access-approve").click();

  await expect(page.locator(".access-panel .access-pending")).toHaveCount(0);
  await page.click('.modal-close[aria-label="Close"]');
  await expect(badge).toHaveCount(0);
});
