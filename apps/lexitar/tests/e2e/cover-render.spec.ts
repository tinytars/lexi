import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider as openAsProviderHelper, loginAs, PILOTS, openPatientNamed, type PilotName } from "./_login";
import { clickNav } from "./_nav";
import { stubChatHistory } from "./_stubs";

const CLIENTS = ["Alex", "Blair"];

// W24 retired the monolithic PDF report. These tests cover what replaced it: the provider roster
// stays PHI-free, each client's dashboard renders without runtime errors, the sections that were
// PDF-only now have on-screen homes, and per-section print hides chrome while showing the active
// view. (Was cover-render.spec — the PDF cover no longer exists.)

// App.svelte's background leaf-regen (W15c/d, generalized M66 P7) fires automatically for any of
// five Finding leaves (treatmentGroups/hypothesisEvaluation/aiOnPlan/treatmentAssessment/studyResults)
// whenever one is stale, independent of which tab is open — a real call needs an Anthropic key local
// dev doesn't have, and its error is incidental noise for a render smoke test, not something these
// tests assert on. Stub the one shared relay with each node's own empty-but-valid shape (read `node`
// off the posted body) — the no-op equivalent of the old per-node dev/no-op early-returns.
const LEAF_REGEN_EMPTY_RESULT: Record<string, unknown> = {
  treatmentGroups: { groups: [] },
  hypothesisEvaluation: { patient: [] },
  aiOnPlan: { rows: [] },
  treatmentAssessment: { items: [] },
  studyResults: { items: [] },
};
async function stubLeafRegen(page: Page) {
  await page.route("**/api/leaf-regen", (route) => {
    const body = route.request().postDataJSON() as { node?: string };
    const result = LEAF_REGEN_EMPTY_RESULT[body.node ?? ""] ?? null;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });
  });
}

async function openClient(page: Page, name: PilotName) {
  await stubChatHistory(page);
  await stubLeafRegen(page);
  await openPatientNamed(page, name);
}

// Investigator (and its Analysis subsection) is provider-only (W34), so reach it via a fam4 drill-in.
async function openAsProvider(page: Page, name: string) {
  await stubChatHistory(page);
  await stubLeafRegen(page);
  await openAsProviderHelper(page, name);
}

test("fam4 (provider) shows a roster of names only — no client data", async ({ page }) => {
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  // .roster renders as soon as providerSession flips, before loadPatients() resolves; wait for the
  // names themselves so a cold-start-slow patient fetch can't be read as an empty roster.
  await page.waitForSelector(".roster-list .roster-name", { timeout: 10_000 });

  const names = (await page.locator(".roster-list .roster-name").allTextContents()).map((s) => s.trim());
  expect(names.sort()).toEqual([...CLIENTS].sort());
  // No client dashboard or section navigation at the provider level. Asserted against `.nav-item`,
  // which renders for every drilled-in patient: `.tabbar` has not existed since M75 retired the
  // two-bar model, so that assertion passed no matter what the roster did.
  await expect(page.locator(".sidebar .nav-list .nav-item")).toHaveCount(0);
});

for (const clientName of CLIENTS) {
  test(`${clientName}'s dashboard renders without runtime errors`, async ({ page }) => {
    const errors: string[] = [];
    // W76 — an attachment blob missing from the DEV R2 is not a render defect, and this environment
    // structurally cannot have those blobs: Alex's vault references real medication-label photos
    // (~200 KB each) that live only in the deployed R2, and copying PHI into the repo or onto a CI
    // runner to seed them is exactly what is forbidden. The browser reports each failed <img> as a
    // generic "Failed to load resource … 404" with no URL in the text, so the URL has to come from
    // the response listener. Only /api/raw/ 404s are forgiven — a 404 on any other path still fails,
    // as does every pageerror and every non-404 console error.
    //
    // This test was passing by RACE, not by correctness: at baseline the 404s landed inside the
    // assertion window once in six runs. W76's suite-wide vault interception resolves the vault from
    // memory instead of the server, which renders sooner and lost that race six times in six. The
    // flake was always here; the fixture only made it honest.
    const missing: string[] = [];
    page.on("response", (r) => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const isBlobMiss = /Failed to load resource/.test(m.text())
        && missing.length > 0 && missing.every((p) => p.startsWith("/api/raw/"));
      if (!isBlobMiss) errors.push(`console.error: ${m.text()}`);
    });

    await openAsProvider(page, clientName);
    await expect(page.locator(".sidebar .nav-list")).toBeVisible();
    // Analysis (Investigator's leftmost subsection after W37 moved Personalization out) mounts the
    // full analytical stack — the strongest single render check.
    await clickNav(page, "Analysis");
    await expect(page.locator(".analysis")).toBeVisible();
    expect(errors, `Runtime errors on ${clientName}: ${errors.join(" | ")}`).toEqual([]);
  });
}

test("Alex's ex-PDF sections have on-screen homes (Clinical Synthesis, Pattern & Anti-pattern, Final Thoughts, Glossary)", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await clickNav(page, "Analysis");
  // M80 — Pattern & Anti-pattern, Clinical Synthesis, and Final Thoughts are direct top-level blocks
  // in Analysis now (the AI Conclusion wrapper was dissolved so each gets its own sidebar nav row).
  for (const sel of [".pattern-antipattern", ".clinical-synthesis", ".final-thoughts"]) {
    await expect(page.locator(`.analysis ${sel}`)).toBeVisible();
  }
  // Glossary is a group row inside Notes now, not a top-level nav row.
  await clickNav(page, "Notes");
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Glossary" }).click();
  await expect(page.locator(".glossary")).toBeVisible();
});

// W65 — the name said "as charts pinned atop the Markers view" and the body asserted neither half:
// a visible `.leaf-card` is what EVERY marker row renders, chart or not. The "pinned atop" claim is
// also stale — M96 Phase 2 made Ratios its own sidebar group rather than a block above the levels.
test("each ratio in the Ratios group renders as its own chart (W36/M96)", async ({ page }) => {
  await openClient(page, "Alex");
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Critical Ratios" })).toHaveCount(0);

  await clickNav(page, "Markers");
  // M96 Phase 2 — Ungrouped is now the sidebar's default group; select Ratios explicitly.
  const ratiosRow = page.locator(".sidebar .group-list .sub-item", { hasText: "Ratios" });
  await ratiosRow.click();

  // The sidebar row's own "(n)" count is the number of ratios on file; the screen must render that
  // many charts, so a ratio silently dropped between the two fails here.
  const count = Number(/\((\d+)\)/.exec((await ratiosRow.innerText()).trim())?.[1] ?? 0);
  expect(count).toBeGreaterThan(0);

  const cards = page.locator(".marker-ratios-screen .stack > .leaf-card");
  await expect(cards).toHaveCount(count);
  // "as charts": MarkerChart's plot is an <svg role="img"> labelled with the ratio's name. A card
  // without one is the fallback text rendering, which is the regression this is here to catch.
  await expect(cards.locator('svg[role="img"]')).toHaveCount(count);
});

test("per-section print: chrome is hidden and only the active section prints", async ({ page }) => {
  await openAsProvider(page, "Alex");
  await clickNav(page, "Analysis");
  await expect(page.locator(".analysis .health-progression")).toBeVisible();

  await page.emulateMedia({ media: "print" });
  // App chrome drops out of the printed page. W63 — a `.tabbar` assertion used to sit here too,
  // and it proved nothing: the class was retired with M75's sidebar, and toBeHidden() passes for an
  // element that does not exist. This test's whole claim is "chrome is hidden", so a vacuous line in
  // the middle of it is worse than none. The two below are the chrome that actually exists.
  await expect(page.locator(".app-header")).toBeHidden();
  await expect(page.locator(".sidebar")).toBeHidden();
  // The active section still renders (it is the print surface now).
  await expect(page.locator(".analysis .health-progression")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
});
