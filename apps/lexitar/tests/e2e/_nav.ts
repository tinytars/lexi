import type { Page } from "@playwright/test";

// Clicks a flat-list nav row in the sidebar (M82 Phase 3 — every section row renders under
// `.nav-list`; M83 — Patient/Investigator now share that list behind a mode toggle at the top, so
// a row belonging to the "other" mode isn't present until the toggle flips). If the target row
// isn't visible yet, flip whichever toggle button isn't currently active, then retry.
//
// Scoped to `.sidebar .nav-list .nav-item`, not a bare `.nav-item`/`.sub-item`: the lower zone below
// the divider (SidebarGroupList/SidebarLeafList) renders its own leaf rows with class `.sub-item`,
// and a leaf row's free-text label (an allergen, a note preview, a study focus) can accidentally
// substring-match a section label like "Family" or "Study".
export async function clickNav(page: Page, label: string) {
  const row = page.locator(".sidebar .nav-list .nav-item", { hasText: label });
  try {
    // A bounded first attempt, relying on Playwright's own actionability retry — the row may just
    // not have rendered yet (e.g. right after a reload), not be hidden behind the other mode.
    await row.click({ timeout: 4_000 });
    return;
  } catch {
    // Genuinely not present under the current mode within that window — flip the toggle and retry.
    await page.locator(".sidebar .mode-toggle button:not(.active)").click();
    await row.click();
  }
}

// W48 — Allergies/Family (and Bio) are no longer flat top-level rows; they're reachable only by
// first landing on Profile, whose lower zone renders them as a SidebarGroupList (`.group-list
// .sub-item`, three rows: Bio/Allergies/Family). Scoped to `.group-list` specifically, not a bare
// `.sub-item`: once Allergies/Family is the active child, its own individual entries ALSO render
// below as a SidebarLeafList (`.leaf-list .sub-item`) — same class, different free-text labels
// that could otherwise collide with "Family"/"Bio" the same way clickNav's own comment warns about.
export async function clickProfileSub(page: Page, label: "Bio" | "Allergies" | "Family") {
  await clickNav(page, "Profile");
  await page.locator(".sidebar .group-list .sub-item", { hasText: label }).click();
}

// M83 — explicitly set the sidebar's Patient/Investigator mode. No-op if the toggle isn't
// rendered at all (a patient session with no Investigator visibility overrides never gets one).
export async function setSidebarMode(page: Page, mode: "patient" | "investigator") {
  const label = mode === "patient" ? "Patient" : "Investigator";
  const button = page.locator(".sidebar .mode-toggle button", { hasText: label });
  if ((await button.count()) > 0) await button.click();
}
