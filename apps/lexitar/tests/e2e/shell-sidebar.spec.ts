import { test, expect } from "./_fixtures";
import { openAsProvider, hashOf } from "./_login";
import { clickNav, setSidebarMode } from "./_nav";
import { unlock } from "./_shell";

// The sidebar's own chrome on desktop (M75): the icon rail, the per-row + action, the blurb
// tooltips, and what print does to it.
//
// Distinct from `shell-nav`, which is about which section is showing; this is about the control that
// gets you there. The phone drawer is `shell-phone` — same component, different viewport.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

// W63 — a skipped test lived here: "deleting one Treatment row doesn't touch an in-progress,
// unsaved edit on another row (M56)". M66 replaced in-place-per-row editing with one shared modal,
// so its premise (two rows mid-edit at once) stopped being reachable, and it was left skipped. Its
// selectors (.persona-action, .tedit) no longer exist in src/ either, so it could never be
// un-skipped as written — a permanent no-op reading as coverage. Deleted; recover the body from git
// history if the invariant is re-covered.
//
// STILL UNCOVERED, and an owner call rather than a mechanical fix: whether an in-progress edit
// should survive an unrelated delete under single-modal editing, and how to test it.

test("Chat's sidebar row carries its blurb as a native tooltip (W37/M77)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Chat" })).toHaveAttribute("title", /Ask about your health data/);
});

test("each subsection's sidebar row carries its blurb as a native tooltip (W37/M77)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  // Treatment (Patient group's leftmost, default-active since M65) shows a subsection blurb.
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Treatment" })).toHaveAttribute("title", /planned, ongoing, or stopped/);
  // Markers (Labs group) carries its own — M62 moved Markers to the Labs tab.
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Markers" })).toHaveAttribute("title", /grouped by body system/);
});

// M75 — the collapsible sidebar shell: desktop rail collapse, and the uniform per-row "+" action
// (navigate + auto-open that section's existing Add flow).
test.describe("sidebar (M75)", () => {
  test("collapses to an icon rail and back on desktop", async ({ page }) => {
    await unlock(page, "Alex");
    await expect(page.locator(".sidebar")).not.toHaveClass(/rail/);
    await clickNav(page, "Markers"); // navigate away from Chat first, so the Chat row's click is a real navigation
    await page.locator(".sidebar-collapse").click();
    await expect(page.locator(".sidebar")).toHaveClass(/rail/);
    // M103 (pet peeves c) — rail mode used to hide the WHOLE .nav-list container, leaving nothing
    // clickable until re-expanded; it now stays visible/actionable, icon-only, with just the
    // per-row text labels hidden.
    const navList = page.locator(".sidebar .nav-list");
    await expect(navList).toBeVisible();
    await expect(navList.locator(".nav-label").first()).toBeHidden();
    // W46/M104 — Search leads the list now, Chat is the second row.
    const chatButton = navList.locator(".nav-item").nth(1);
    await expect(chatButton.locator(".side-icon")).toBeVisible();
    await chatButton.click();
    await expect(page).toHaveURL(new RegExp(`${hashOf.Alex}/chat`));
    await page.locator(".sidebar-collapse").click();
    await expect(page.locator(".sidebar")).not.toHaveClass(/rail/);
  });

  // M82 Phase 4 — DELETED: "a rail-mode click restores the tab's last-active section". Its premise
  // (click a tab, expand its last-active child section) no longer exists now that there's no
  // parent-tab-then-child-section interaction; App.svelte's lastSectionByTab was removed in Phase 4.

  test("the + action on Chat starts a new chat", async ({ page }) => {
    await unlock(page, "Alex");
    await clickNav(page, "Markers"); // navigate away from Chat first (Questions is nested in Notes now)
    // Scoped to the sidebar action button — an untitled thread's own sidebar row
    // defaults to the same "New chat" title text and would otherwise collide.
    await page.locator('.side-row-action[title="New chat"]').click();
    await expect(page).toHaveURL(/#.*chat/);
    await expect(page.locator(".chat-tab textarea")).toBeVisible();
  });

  test("the + action on a sub-section navigates there and opens its Add modal", async ({ page }) => {
    await unlock(page, "Alex");
    await page.getByTitle("Add note").click();
    await expect(page).toHaveURL(/#.*notes/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("Markers/Reports' + opens the Import modal (M84)", async ({ page }) => {
    await unlock(page, "Alex");
    await page.getByTitle("Import spreadsheet").click();
    await expect(page).toHaveURL(/#.*markers/);
    await expect(page.locator(".import-tab")).toContainText("Drop a health report");
    await page.keyboard.press("Escape");
    await page.getByTitle("Import report").click();
    await expect(page).toHaveURL(/#.*healthReports/);
    await expect(page.locator(".import-tab")).toContainText("Drop a health report");
  });

  test("sections with no add action show no + icon", async ({ page }) => {
    await unlock(page, "Alex");
    // Scoped to Questions/Glossary's own rows, not the whole sidebar — Chat's always-visible
    // top-level "New chat" action lives outside the flat list and would otherwise false-positive.
    const questionsRow = page.locator(".sidebar .nav-list .side-row").filter({ has: page.locator(".nav-item", { hasText: "Questions" }) });
    const glossaryRow = page.locator(".sidebar .nav-list .side-row").filter({ has: page.locator(".nav-item", { hasText: "Glossary" }) });
    await expect(questionsRow.locator(".side-row-action")).toHaveCount(0);
    await expect(glossaryRow.locator(".side-row-action")).toHaveCount(0);
  });

  test("Investigator → Analysis has no + icon, but its sibling Study/Hypothesis sub-sections do", async ({ page }) => {
    await openAsProvider(page, "Alex");
    // M83 — Investigator's rows only render once the sidebar's mode toggle is flipped.
    await setSidebarMode(page, "investigator");
    const analysisRow = page.locator(".sidebar .nav-list .side-row").filter({ has: page.locator(".nav-item", { hasText: "Analysis" }) });
    await expect(analysisRow.locator(".side-row-action")).toHaveCount(0);
    await expect(page.getByTitle("Add study")).toBeVisible();
    await expect(page.getByTitle("Add idea")).toBeVisible();
  });

  test("print hides the sidebar", async ({ page }) => {
    await unlock(page, "Alex");
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".sidebar")).not.toBeVisible();
  });
});

// Chat's thread list gains the same collapsible All row every other section has.
test("Chat's All row collapses and re-expands the thread list", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await page.locator(".sidebar .nav-item", { hasText: "Chat" }).first().click();
  const chevron = page.locator('.sidebar .group-list [aria-label="Collapse All"]');
  await expect(chevron).toBeVisible();
  await expect(page.locator(".sidebar .group-children .leaf-list")).toBeVisible();
  await chevron.click();
  await expect(page.locator(".sidebar .group-children .leaf-list")).toHaveCount(0);
  await page.locator('.sidebar .group-list [aria-label="Expand All"]').click();
  await expect(page.locator(".sidebar .group-children .leaf-list")).toBeVisible();
});
