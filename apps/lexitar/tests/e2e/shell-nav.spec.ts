import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./_login";
import { openSynthetic, openSyntheticAsProvider, mySynthetic, E2E_CLINICIAN } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav, setSidebarMode, navRow } from "./_nav";

// W11g/h: the primary navigation shell — hash deep-link / back-button, the on-screen Report, the
// Import placeholder, and downloads. M82 Phase 3 flattened the old two-tier tab+accordion sidebar
// into one flat `.nav-list`; M83 split that list behind a Patient/Investigator mode toggle
// (default: Patient) — only the active mode's rows render at a time.
//
// This file keeps the original's name and its subject: which section is showing, and how you got
// there. The sidebar's own chrome is `shell-sidebar`; the phone drawer is `shell-phone`.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

// M83 — reads the flat list's own row labels, in DOM order, excluding the ungrouped Chat row.
// Only one mode's rows render at a time now (behind the Patient/Investigator toggle), so there's
// no more header-scoping to do (the old `.nav-group-label` markup is gone). M84 — every row now
// nests its icon in a separate <span>, so innerText is "<icon>\n<label>"; strip the icon line.
// M91 — the Search row is likewise ungrouped (not a SectionMeta), excluded the same way as Chat.
async function navItemLabels(page: Page): Promise<string[]> {
  const items = await page.locator(".sidebar .nav-list .nav-item").allInnerTexts();
  return items
    .map((t) => t.replace(/●/g, "").trim())
    .map((t) => t.split("\n").filter(Boolean).pop()!.trim())
    .filter((t) => t !== "Chat" && t !== "Search");
}

test("Chat is the landing tab", async ({ page }) => {
  await openSynthetic(page);
  await expect(navRow(page, "Chat")).toHaveClass(/active/);
  await expect(page.locator(".chat-tab textarea")).toBeVisible();
});

test("tabs switch and update the hash", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Treatment");
  await expect(navRow(page, "Treatment")).toHaveClass(/active/);
  await expect(page).toHaveURL(/#.*treatment/);

  // Investigator is provider-only (W35), so a patient switches between the two patient tabs.
  await clickNav(page, "Chat");
  await expect(page.locator(".chat-tab textarea")).toBeVisible();
  await expect(page).toHaveURL(/#.*chat/);
});

test("deep-link to a tab via the hash", async ({ page }) => {
  const who = mySynthetic();
  await loginAs(page, who.email, who.password, "/#doctor");
  await page.waitForSelector(".sidebar .nav-item", { timeout: 10_000 });
  // The legacy "#doctor" hash resolves to Treatment via LEGACY_TAB_DEFAULT.
  await expect(navRow(page, "Treatment")).toHaveClass(/active/);
  await expect(page.locator(".unified-treatment")).toBeVisible();
});

test("the browser back button returns to the previous tab", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Treatment");
  await expect(page).toHaveURL(/#.*treatment/);
  await clickNav(page, "Chat");
  await expect(page).toHaveURL(/#.*chat/);
  await page.goBack();
  await expect(page).toHaveURL(/#.*treatment/);
  await expect(navRow(page, "Treatment")).toHaveClass(/active/);
});

test("Investigator → Analysis consolidates the analytical sections; Study/Hypothesis/Exploration sit beside it (W34/M80)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  // M83 — Investigator's rows only render once the sidebar's mode toggle is flipped.
  await setSidebarMode(page, "investigator");
  const subs = await navItemLabels(page);
  // W37 moved Personalization out to the Patient tab (→ Profile), so Analysis leads Investigator
  // again. M80 — Exploration promoted out of Analysis to its own subsection, last. W61 —
  // Recommended Markers left Investigator entirely: it renders nested under Notes now (owner's
  // instruction), so Investigator is back to these four.
  expect(subs).toEqual(["Analysis", "Study", "Hypothesis", "Exploration"]);
  // Analysis (first now) stacks its 6 blocks (M80 flattened AI Conclusion's 3 children to top-level).
  await clickNav(page, "Analysis");
  const analysis = page.locator(".analysis");
  // W62 — the six blocks are identified by their anchor ids now, not by a visible heading. The
  // per-block <h2> was removed: it sat OUTSIDE the leaf card (unlike every other title in the app)
  // and duplicated the cell's own title on the single-item blocks. The block labels are still shown
  // — in the sidebar, which is asserted above. Order still matters, so it is still asserted here,
  // including M52's rule that the holistic plan assessment sits directly above System Analysis.
  const ids = await analysis.locator(".an-block").evaluateAll((ns) => ns.map((n) => n.id));
  expect(ids).toEqual([
    "analysis-progression",
    "analysis-ontreatment",
    "analysis-system",
    "analysis-pattern-antipattern",
    "analysis-clinical-synthesis",
    "analysis-final-thoughts",
  ]);
  await expect(analysis).not.toContainText("Study Result");
  // Still rendered in the persona visual language — an AI bubble.
  await expect(analysis.locator(".persona-bubble.p-assistant").first()).toBeVisible();
  // Hypothesis is its own sub-tab to the right.
  await clickNav(page, "Hypothesis");
  await expect(page.locator(".future-treatment")).toBeVisible();
  // Exploration (M80) is last, promoted out of Analysis.
  await clickNav(page, "Exploration");
  await expect(page.locator(".tests-consider")).toBeVisible();
});

test("Provider can inspect the Translation DAG structure", async ({ page }) => {
  // The DAG is structural (FindingDag.svelte renders it with no client selected), so the e2e
  // clinician shows the identical graph fam4 would — no need for the real provider account.
  await loginAs(page, E2E_CLINICIAN.email, E2E_CLINICIAN.password);
  await expect(page.locator(".roster")).toBeVisible();
  await page.getByRole("button", { name: "Translation DAG" }).click();
  await expect(page.locator(".dag")).toBeVisible();
  // Click the disease-finding hub; its downstream invalidation set is non-empty.
  await page.locator(".dag .node", { hasText: "LexiTar Findings (disease)" }).click();
  await expect(page.locator(".dag .detail")).toContainText("Editing this invalidates");
  await expect(page.locator(".dag .detail .k-down")).not.toContainText("(0)");
});

test("Patient mode lists all patient-facing sections in one flat nav list, with no mode toggle for a no-override session (M65/M62/M82/M83)", async ({ page }) => {
  await openSynthetic(page);
  // Notes leads, then Treatment above Markers. Questions and Glossary are no longer flat rows —
  // they nest inside Notes' own lower zone (All / Questions / Glossary), the same way Allergies and
  // Family nest under Profile. Symptoms was fully removed (W49).
  const subs = await navItemLabels(page);
  expect(subs).toEqual(["Notes", "Treatment", "Markers", "Reports", "Profile"]);
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Questions");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Glossary");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Exploration");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Clinical Reports");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Allergies");
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Family");
  // Analysis lives in Investigator (provider-only), not here.
  await expect(page.locator(".sidebar .nav-list")).not.toContainText("Analysis");
  // A patient session with no Investigator visibility overrides never gets the mode toggle at all.
  await expect(page.locator(".sidebar .mode-toggle")).toHaveCount(0);

  // W48 — clicking Profile reveals its own lower zone: Bio/Allergies/Family, in that order.
  await clickNav(page, "Profile");
  const groupLabels = await page.locator(".sidebar .group-list .sub-item").allInnerTexts();
  expect(groupLabels.map((t) => t.replace(/\s*\(\d+\)$/, ""))).toEqual(["Bio", "Allergies", "Family"]);
});

test("the Critical Ratios tab is retired (W30 — ratios live on the Markers charts)", async ({ page }) => {
  await openSynthetic(page);
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Critical Ratios" })).toHaveCount(0);
  // The old hash must not strand the app on a blank screen. `.critical-ratios` was the retired
  // component's own class — asserting its absence was true by deletion and said nothing about what
  // #ratios does now, which is the only part a user can still reach.
  await page.goto("/#ratios");
  await expect(page.locator(".sidebar .nav-list .nav-item")).not.toHaveCount(0);
});

test("the About link opens the report introduction overlay", async ({ page }) => {
  await openSynthetic(page);
  // M78 Phase 9 — About moved off the header into the account menu (sidebar bottom); its items
  // are role="menuitem", not role="button".
  await page.click(".account-trigger");
  await page.getByRole("menuitem", { name: "About" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("decision-support system");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Import is reachable via the top-right kebab; the flat nav list has no mode toggle for a patient with no Investigator overrides", async ({ page }) => {
  await openSynthetic(page);
  // W46/M104 — Search leads (Search → Chat → Notes → Questions → ...). M83 —
  // Investigator (ex-AI Thoughts) rows live behind the Patient/Investigator mode toggle,
  // provider-only; a patient session with no visibility overrides never gets the toggle at all,
  // so there's no way in from here.
  await expect(page.locator(".sidebar .nav-list .nav-item").first()).toHaveText(/Search/);
  await expect(page.locator(".sidebar .nav-list .nav-item").nth(1)).toHaveText(/Chat/);
  await expect(page.locator(".sidebar .mode-toggle")).toHaveCount(0);

  // M81 removed Import's old block-level sidebar button; M84 restores a "+" for Markers/Reports
  // specifically (see the "sidebar (M75)" describe block), which the kebab mirrors (M78 Phase 14) —
  // exercise the kebab path here.
  await clickNav(page, "Reports");
  await clickLeafMenuItem(page.locator(".page-kebab"), "Import");
  await expect(page.locator(".import-tab")).toContainText("Drop a health report");
});

// Questions and Glossary moved under Notes; their old permalinks are still live links.
test("a #docInference permalink lands on Notes with Questions selected", async ({ page }) => {
  await openSyntheticAsProvider(page);
  // Build the hash from the client segment rather than string-replacing the last one: the hash may
  // carry no section at all, in which case a blind replace eats the client id.
  await page.evaluate(() => {
    const client = window.location.hash.replace(/^#/, "").split("/")[0];
    window.location.hash = `#${client}/docInference`;
  });
  await expect(page.locator(".sidebar .nav-item.active")).toContainText("Notes");
  await expect(page.locator(".sidebar .group-list .sub-item.active")).toHaveText(/Questions/);
});
