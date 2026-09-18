import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider, openSyntheticAsProviderAt, syntheticAt } from "./_synthetic";
import { openLeafMenu, clickLeafMenuItem, leafMenuPanel, menuPanelFor } from "./_leaf-menu";
import { clickNav, setSidebarMode } from "./_nav";

// M104 — LeafActionMenu (every leaf row's ⋮) and AccountMenu each used to own fully independent
// open/closed state; opening one never closed another. menu-registry.svelte.ts makes every
// popover in the app share one "which menu is open" signal instead. Adds its own two Notes rows
// (cleaned up at the end) rather than depending on real seeded data having 2+ rows on one tab.

async function addNote(page: Page, text: string) {
  await page.getByTitle("Add note").click();
  await page.locator(".nt-modal .note-input").fill(text);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });
}

test("opening any menu closes whichever other menu (leaf or account) was open, in both directions", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const a = `M104 menu-a ${Date.now()}`;
  const b = `M104 menu-b ${Date.now()}`;

  await openSyntheticAsProvider(page);
  await clickNav(page, "Notes");
  await addNote(page, a); // appended (Notes.svelte pushes), so `a` renders above `b`.
  await addNote(page, b);

  const rowA = page.locator(".notes .leaf-card", { hasText: a });
  const rowB = page.locator(".notes .leaf-card", { hasText: b });

  // W46 Phase 1 — panels are portaled to <body>, no longer descendants of their row, so exclusivity
  // is asserted via each trigger's stable `aria-controls` id (menuPanelFor/leafMenuPanel) rather
  // than a row-scoped locator.
  const panelA = await leafMenuPanel(rowA);
  const panelB = await leafMenuPanel(rowB);
  const accountPanel = await menuPanelFor(page.locator(".account-trigger"));

  // Leaf menu vs leaf menu: open the LOWER row (B) first — its dropdown opens downward into empty
  // space below it. Opening the row ABOVE it (A) next never requires hovering/clicking anything
  // covered by B's still-open panel, since B is below A, not on top of it.
  await openLeafMenu(rowB);
  await expect(panelB).toBeVisible();
  await openLeafMenu(rowA);
  await expect(panelA).toBeVisible();
  await expect(panelB).not.toBeVisible();

  // Leaf menu vs AccountMenu: opening the account menu (in the sidebar, no overlap with the main
  // content) closes A's (still open from above).
  await page.click(".account-trigger");
  await expect(accountPanel).toBeVisible();
  await expect(panelA).not.toBeVisible();

  // AccountMenu vs leaf menu, reverse order: opening A's closes the account menu. A's row is
  // unaffected by the account menu's own dropdown (sidebar-bottom, nowhere near main content).
  await openLeafMenu(rowA);
  await expect(panelA).toBeVisible();
  await expect(accountPanel).not.toBeVisible();

  await page.keyboard.press("Escape");
  await clickLeafMenuItem(rowA, /Delete/);
  await clickLeafMenuItem(rowB, /Delete/);
  await expect(page.locator(".notes")).not.toContainText(a);
  await expect(page.locator(".notes")).not.toContainText(b);
});

// M105 — the sidebar's Patient/Investigator toggle only ever swapped which row list was shown; it
// never moved the main pane, and nothing survived re-entering the vault. Now each (role, client)
// pair remembers its own last section in localStorage, and flipping the toggle navigates there.
test("switching sidebar mode restores the last section visited in that mode, per client, across a fresh vault entry", async ({ page }) => {
  const patientA = await openSyntheticAsProviderAt(page, 0);

  // Land on a Patient section, then switch to Investigator and pick a different section there.
  await clickNav(page, "Treatment");
  await setSidebarMode(page, "investigator");
  await clickNav(page, "Exploration");
  await expect(page.locator(".sidebar .nav-list .nav-item.active", { hasText: "Exploration" })).toBeVisible();

  // Re-enter patientA's vault from a fresh, hash-less navigation (a provider session auto-resumes
  // straight to the roster — never back into a specific patient — so this, not page.reload(), is
  // the real "cold start into this vault" case: no deep-link hash to carry the location, only the
  // memory). The provider session itself is already resumed, so re-navigating to "/" lands right
  // back on the roster (no login form to fill), unlike openSyntheticAsProviderAt's first call.
  await page.goto("/");
  await page.waitForSelector(`.roster-name:has-text("${patientA.name}")`);
  await page.click(`.roster-name:has-text("${patientA.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  await expect(page.locator(".sidebar .mode-toggle button.active", { hasText: "Investigator" })).toBeVisible();
  await expect(page.locator(".sidebar .nav-list .nav-item.active", { hasText: "Exploration" })).toBeVisible();

  // Flip back to Patient: jumps straight to Treatment (the section remembered for patientA/patient),
  // not just the first Patient row (Markers).
  await setSidebarMode(page, "patient");
  await expect(page.locator(".sidebar .nav-list .nav-item.active", { hasText: "Treatment" })).toBeVisible();

  // A different client's memory is independent — patientB has no remembered location yet, so
  // entering their vault lands on the plain chat default, not patientA's Exploration/Treatment.
  const patientB = syntheticAt(1);
  await page.goto("/");
  await page.waitForSelector(`.roster-name:has-text("${patientB.name}")`);
  await page.click(`.roster-name:has-text("${patientB.name}")`);
  await page.waitForSelector(".sidebar .nav-item");
  await expect(page).not.toHaveURL(/exploration/);
  await expect(page.locator(".sidebar .nav-list .nav-item.active", { hasText: "Chat" })).toBeVisible();
});
