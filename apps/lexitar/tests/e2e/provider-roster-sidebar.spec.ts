import { test, expect } from "./_fixtures";
import { loginAs } from "./_login";
import { E2E_CLINICIAN } from "./_synthetic";

// The roster used to be a full-width header over a centred column, while the record shell one click away
// was a persistent left bar with the account menu in its lower-left — the same product in two layouts.
// These pin the roster's half: a sidebar, the account controls at the bottom of it, and the drawer that
// is the only way to reach them on a phone.

test("the roster carries the app's left bar, with the account menu in its lower-left", async ({ page }) => {
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await expect(page.locator(".roster")).toBeVisible();

  const nav = page.locator(".sidebar .nav-list");
  await expect(nav).toBeVisible();
  const trigger = page.locator(".sidebar .sidebar-account .account-trigger");
  await expect(trigger).toBeVisible();

  // Geometric, not just present: "lower left" is the claim, and a CSS regression that moved the block
  // back to the top would satisfy a presence check.
  const navBox = (await nav.boundingBox())!;
  const acctBox = (await trigger.boundingBox())!;
  expect(acctBox.y).toBeGreaterThan(navBox.y + navBox.height);
  expect(acctBox.x).toBeLessThan(400); // inside the 280px bar, not the page
});

test("the Translation DAG is a nav row with a way back to Patients", async ({ page }) => {
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await expect(page.locator(".roster-list")).toBeVisible();

  await page.getByTestId("nav-dag").click();
  await expect(page.locator(".dag")).toBeVisible();
  await expect(page.locator(".roster-list")).toHaveCount(0);

  // The old header button relabelled itself, so there was no independent destination to come back to.
  await page.getByTestId("nav-patients").click();
  await expect(page.locator(".roster-list")).toBeVisible();
  await expect(page.locator(".dag")).toHaveCount(0);
});

test("on a phone the roster's sidebar is a drawer that ☰ opens and a row closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await expect(page.locator(".roster")).toBeVisible();

  // Without the toggle the provider cannot reach the account menu at all at this width.
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).not.toHaveClass(/open/);
  await page.click(".sidebar-toggle");
  await expect(sidebar).toHaveClass(/open/);
  await expect(page.locator(".sidebar .sidebar-account .account-trigger")).toBeVisible();

  await page.getByTestId("nav-dag").click();
  await expect(sidebar).not.toHaveClass(/open/);
  await expect(page.locator(".dag")).toBeVisible();
});
