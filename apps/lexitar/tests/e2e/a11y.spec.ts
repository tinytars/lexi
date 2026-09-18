import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSynthetic } from "./_synthetic";
import { clickNav } from "./_nav";
import { openLeafMenu } from "./_leaf-menu";

// W70 Phase 3 — automated accessibility checks. The app had none across 45 specs.
//
// Drives the WORKER'S OWN synthetic patient, so it needs no credential and cannot disturb other specs.
//
// THE ASSERTION IS A RATCHET, NOT A ZERO. A zero-tolerance gate on an app this size fails on day one
// and gets commented out within a week — at which point it protects nothing while looking like it
// does. Instead each surface carries the count observed when it was measured; the run fails if the
// count goes UP, and the number is lowered as things are fixed. That makes "we did not make it worse"
// enforceable today and "we made it better" visible over time.
//
// Note what this does NOT do: replace tests/unit/a11y-static.test.ts. Those pin the specific defects
// this milestone fixed, in the specific places it fixed them, and run in the HOSTED job — so the
// regressions we already paid for are guarded without waiting on a browser.

/** WCAG 2.0/2.1 A and AA. Deliberately a fixed set: adding tags later must be a decision, not a drift. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Violations tolerated per surface. LOWER these as fixes land; never raise one without saying why in
 * the same commit.
 *
 * PROVISIONAL, and deliberately loose on the first pass. The real counts cannot be known without a
 * browser run, and this suite may not be run locally (it shares port 8788 with CI). A guessed-tight
 * number would fail for reasons unrelated to the change under test, so these start high; `scan` prints
 * the actual count and rule ids on every run, and the next commit replaces these with the measured
 * values. A ratchet is only useful once its notch is real.
 */
// MEASURED, not guessed — every notch here is a count CI actually reported (runs 32751134368 and
// 32753895860). Two surfaces are already zero, which is the point of measuring rather than assuming.
//
// What the markers count is made of, and why it is not zero yet:
//   • nested-interactive ×6 — FIXED: MarkerChart's card wrapper was a role="button" containing real
//     buttons; the affordance is now a real <button> around the chart figure, which contains nothing
//     interactive. axe found this independently of the audit that first flagged it.
//   • select-name ×1 (CRITICAL) — FIXED in this commit (Sidebar.svelte's window dropdown), which is
//     why the markers notch is 2 rather than the 3 first measured. This is the ratchet doing its job.
//   • color-contrast ×30 — a palette question, not a markup one; it needs a design decision, not a
//     unilateral change to brand colours.
const BASELINE: Record<string, number> = {
  "sign-in": 0, // the login fix landed: was placeholder-only, now every control has a name
  notes: 1, // color-contrast ×1
  markers: 1, // color-contrast ×30 only — select-name and nested-interactive are both fixed (3 -> 2 -> 1)
  "open modal": 0, // the <dialog> migration is clean
  "open row menu": 1, // measured once the spec stopped timing out; was a guessed 3
};

async function scan(page: Page, surface: string) {
  // @axe-core/playwright bundles its own copy of Playwright's Page type, which is a version behind
  // this workspace's — structurally compatible for everything AxeBuilder actually calls, but not
  // assignable. Cast once, here, rather than loosening the whole file: the boundary is the mismatch.
  const { violations } = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] })
    .withTags(TAGS)
    .analyze();
  const summary = violations
    .map((v) => `${v.id} (${v.impact ?? "n/a"}) ×${v.nodes.length}`)
    .join("\n    ");
  // Printed on every run, pass or fail: the point of a ratchet is that the number is visible and
  // someone can lower it. A silent pass teaches nobody what is left.
  // eslint-disable-next-line no-console
  console.log(`[a11y] ${surface}: ${violations.length} violation(s)${summary ? `\n    ${summary}` : ""}`);
  expect(
    violations.length,
    `${surface}: ${violations.length} violations, baseline ${BASELINE[surface]}. If this went UP, the change under test regressed accessibility. If it went DOWN, lower the baseline in this file.`,
  ).toBeLessThanOrEqual(BASELINE[surface]);
}

test("the sign-in screen", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('input[type="email"]');
  // The first thing every patient touches, and the one screen where a failure locks them out entirely.
  await scan(page, "sign-in");
});

test("a section page", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await scan(page, "notes");
});

test("the markers view, where clinical status is rendered", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Markers");
  await scan(page, "markers");
});

test("an open modal", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await page.getByTitle("Add note").click();
  await expect(page.locator("dialog.modal-panel")).toBeVisible();
  await scan(page, "open modal");
});

test("an open row menu — the primary Delete/Edit/Chat surface", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Notes");
  // The shared helper, not a guessed selector — and NO conditional skip. A test that skips when its
  // target is missing is indistinguishable from one that passed, which is the failure mode this
  // milestone keeps finding. If the menu cannot be opened, that is a result worth failing on.
  // Mirrors the proven locator in chat-from-leaf.spec.ts:113 — a card that HAS a trigger — rather
  // than a sidebar row, which carries none. The first version guessed and timed out.
  await openLeafMenu(page.locator(".leaf-card").filter({ has: page.locator(".leaf-menu-trigger") }).first());
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  await scan(page, "open row menu");
});
