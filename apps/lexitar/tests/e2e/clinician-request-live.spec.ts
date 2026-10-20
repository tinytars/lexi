// The clinician half of access-request-live.spec.ts, and the first test of a path that did not
// exist: until now only an internal support account could ask, so a doctor was added only by a
// patient finding them unprompted.
//
// Unstubbed for the reason that spec gives — the fetch is what failed in production, and a routed
// literal proves the rendering while proving nothing about the load. It also covers the defect this
// work exists to fix, which a stub could not reach at all: the patient's own privacy screen used to
// compute "who can read my record" as "everything that is not a pending SUPPORT request", so this
// request would have rendered as access already granted, with Revoke and no Approve.
import { test, expect } from "@playwright/test";
import { loginAs, signUp, ownerSignOut } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { E2E_CLINICIAN, clinicianRosterLoaded, patientRosterRows } from "./_synthetic";

// One flow, as the support spec is: seeding a real request costs a signup, a clinician login and a
// re-login, and every assertion below is a stage of the same request's life.
test("a clinician asks, the patient sees a request rather than a grant, and approving grants it", async ({ page }) => {
  const patientEmail = `e2e-ask-pat-${Date.now()}@local.invalid`;
  const pw = "e2e-pass-123";

  await signUp(page, patientEmail, pw);
  await ownerSignOut(page);

  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  // The console renders empty while the fetch is in flight, so waiting on it would count zero rows
  // and then compare against a loaded list. The first row is the signal the fetch resolved, and this
  // clinician always has one: cover-render.spec.ts asserts its roster exactly.
  await clinicianRosterLoaded(page);
  const rosterBefore = await patientRosterRows(page).count();
  await page.fill(".access-add input", patientEmail);
  await page.click('.access-add button:has-text("Request access")');
  await expect(page.locator(".access-add input")).toHaveValue(""); // the POST settled
  // The clinician is told where the decision is, because nothing will appear on their own roster:
  // an invited link is not a granted patient and /api/providers/patients returns granted ones.
  await expect(page.locator(".access-empty")).toContainText(patientEmail);
  await expect(patientRosterRows(page)).toHaveCount(rosterBefore);
  await expect(patientRosterRows(page).filter({ hasText: patientEmail })).toHaveCount(0);
  await ownerSignOut(page);

  await loginAs(page, patientEmail, pw);
  const badge = page.locator('[data-testid="access-request-badge"]');
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).toHaveText(/1 access request waiting/i);

  await badge.click();
  const pending = page.getByTestId("access-pending-row");
  await expect(pending).toContainText(E2E_CLINICIAN.name);
  await expect(pending).toContainText("Asked to read your record.");
  // The defect, from the patient's side: before the fix this row rendered in the list below instead,
  // which says these people CAN read the record — and offered no way to let them.
  await expect(pending.getByTestId("access-approve")).toBeVisible();
  // W79 — there IS a clock now, and it is the patient's to set before they answer. Radios rather
  // than a select, so the default is a choice they can see rather than one they never opened, and
  // 30 days is what they get by pressing Approve without touching it.
  await expect(pending.locator("select")).toHaveCount(0);
  await expect(pending.locator(".duration .opt.selected")).toHaveText("30 days");

  await pending.getByTestId("access-approve").click();
  await expect(pending).toHaveCount(0);
  const granted = page.getByTestId("access-active-row");
  await expect(granted).toContainText(E2E_CLINICIAN.name);
  // Both ends of one grant print the same window: the patient's row says when it ends. The date
  // itself is deliberately not matched — the browser runs the machine's locale ("Ends Nov 19")
  // while the vocabulary unit tests pin en-GB ("Ends 19 Nov"), so a spec that spelled the date out
  // would be asserting the test runner's locale rather than the product's behaviour.
  await expect(granted).toContainText(/Ends \S+/);
  await expect(granted).toContainText("You can renew or revoke at any time.");
  await page.click('.modal-close[aria-label="Close"]');
  await expect(badge).toHaveCount(0);

  // Teardown, and an assertion in its own right. The roster is shared server state —
  // cover-render.spec.ts asserts this clinician's roster exactly — so a patient left on it would
  // fail an unrelated spec on the next run. Revoking is also the patient's half of the consent loop.
  await badge.waitFor({ state: "detached" });
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Who can access")');
  await clickLeafMenuItem(page.getByTestId("access-active-row"), "Revoke access");
  await expect(page.getByTestId("access-empty")).toHaveText("Only you.");
});
