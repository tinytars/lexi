import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider, openPatientNamed, type PilotName } from "./_login";
import { clickNav, setSidebarMode } from "./_nav";

// W15/3a — provider drill-in + provider-configurable patient visibility. The provider (fam4)
// opens a patient's record and sees every section; a patient's own session sees only the
// patient-audience ones (the Investigator tab — Analysis + Hypothesis — is provider-only, W34).

async function providerInto(page: Page, patient: string) {
  await openAsProvider(page, patient);
}

async function asPatient(page: Page, name: PilotName) {
  await openPatientNamed(page, name);
}

test("provider drills into a patient and sees the provider-only Investigator tab", async ({ page }) => {
  await providerInto(page, "Alex");
  // Provider controls are present — M62 moved Back to roster + Visibility into the AccountMenu pulldown.
  await page.locator(".account-trigger").click();
  await expect(page.getByRole("menuitem", { name: "← Back to roster" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Visibility" })).toBeVisible();
  await page.keyboard.press("Escape");
  // W37 — Investigator is now Analysis · Study · Hypothesis; Personalization moved out to
  // the Patient tab (→ Profile). M83 — Investigator's sections render only in Investigator mode,
  // behind the sidebar's Patient/Investigator toggle.
  await setSidebarMode(page, "investigator");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Analysis");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Study");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Hypothesis");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Personalization");
  // Study is its own provider-only subsection (moved out of Analysis).
  await clickNav(page, "Study");
  await expect(page.locator(".study")).toBeVisible();

  // The folded-in editor now lives at Patient → Profile (M65 — Treatment leads the Patient tab,
  // followed by Profile). W48 — Allergies/Family are no longer flat rows; they nest under Profile's
  // own lower zone (Bio/Allergies/Family). M83 — switch back to Patient mode to see its rows (only
  // one mode's rows render at a time).
  await setSidebarMode(page, "patient");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Treatment");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Profile");
  await clickNav(page, "Profile");
  await expect(page.locator(".personalization")).toBeVisible();
  await expect(page.locator(".sidebar .group-list")).toContainText("Allergies");
  await expect(page.locator(".sidebar .group-list")).toContainText("Family");
});

test("a patient's own session hides the provider-only Investigator tab but keeps the rest", async ({ page }) => {
  await asPatient(page, "Alex");
  // No provider controls.
  await expect(page.getByRole("button", { name: "Visibility", exact: true })).toHaveCount(0);
  // Investigator (Analysis + Study + Hypothesis + Exploration) is provider-only — none of its
  // sections render for a patient, so the Patient/Investigator mode toggle doesn't render either
  // (Sidebar.svelte only shows it when investigatorRows is non-empty).
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Analysis");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Study");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Hypothesis");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Exploration");
  // The Patient tab and its patient sections remain — already visible in the same flat list.
  // W37 — Profile (the folded-in editor) is patient-visible; M65 — Treatment now leads the Patient
  // tab. W48 — Allergies and Family (both still patient-audience by default) are patient-visible
  // too, but only reachable nested under Profile now, not as flat rows.
  await expect(page.locator(".sidebar .nav-list")).toContainText("Profile");
  await expect(page.locator(".sidebar .nav-list")).toContainText("Treatment");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Analysis");
  await clickNav(page, "Profile");
  await expect(page.locator(".sidebar .group-list")).toContainText("Allergies");
  await expect(page.locator(".sidebar .group-list")).toContainText("Family");
  // M62 — Reports moved to the Labs tab, still patient-visible.
  await expect(page.locator(".sidebar .nav-list")).toContainText("Reports");
});

test("the Visibility panel lists the configurable features", async ({ page }) => {
  await providerInto(page, "Alex");
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: "Visibility" }).click();
  const vis = page.locator(".vis");
  await expect(vis).toContainText("Profile"); // W37 — personalization is labeled Profile
  await expect(vis).toContainText("Analysis");
  await expect(vis).toContainText("Hypothesis");
  await expect(vis.locator("input[type=checkbox]").first()).toBeVisible();
});
