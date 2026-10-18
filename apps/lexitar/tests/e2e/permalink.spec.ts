import { test, expect } from "./_fixtures";
import { createHash } from "node:crypto";
import { openSynthetic, mySynthetic } from "./_synthetic";
import { clickNav, navRow } from "./_nav";
import { clickLeafMenuItem } from "./_leaf-menu";

// W38 — every navigation mirrors the current location into the URL hash (a real, pastable
// permalink), and pasting that link resolves back to the same place. M84 removed the sidebar's
// per-row 🔗 "copy" affordance (the address bar itself is the copy source now), but body-content
// headings (e.g. a treatment row) still carry their own 🔗 via HeadingAnchor — those are untouched.

test("a section's URL is a permalink to that section, and it round-trips", async ({ page, context }) => {
  await openSynthetic(page);
  const hash = `#${mySynthetic().slug}`;

  await clickNav(page, "Treatment");
  await expect(page).toHaveURL(new RegExp(`${hash}/treatment$`));

  // M84 — the sidebar's per-row 🔗 copy-link button was removed (the address bar itself already
  // tracks the current section on every navigation); the browser's own URL is the permalink now,
  // with no separate "copy" affordance to test.
  const copied = page.url();
  expect(copied).toMatch(new RegExp(`${hash}/treatment$`));

  // Paste it into a fresh page → unlock → it resolves to the Treatment section.
  const fresh = await context.newPage();
  // W49 — the new page shares this context's session (cookie + persisted key), so it auto-resumes;
  // the permalink in the URL is applied once the vault reopens. No re-login needed.
  await fresh.goto(copied, { waitUntil: "networkidle" });
  await fresh.waitForSelector(".sidebar .nav-item", { timeout: 15_000 });
  await expect(fresh).toHaveURL(new RegExp(`${hash}/treatment$`));
  await expect(navRow(fresh, "Treatment")).toHaveClass(/active/);
  await fresh.close();
});

test("a component 🔗 (a treatment) copies a deep anchor that round-trips and highlights", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSynthetic(page);
  const hash = `#${mySynthetic().slug}`;

  await clickNav(page, "Treatment");
  await page.locator(".ct-drug .permalink-grab").first().click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(new RegExp(`${hash}/treatment/rx-[a-z0-9-]+$`));

  const anchorId = decodeURIComponent(copied.split("/").pop()!);
  const fresh = await context.newPage();
  // W49 — the new page shares this context's session (cookie + persisted key), so it auto-resumes;
  // the permalink in the URL is applied once the vault reopens. No re-login needed.
  await fresh.goto(copied, { waitUntil: "networkidle" });
  await fresh.waitForSelector(".sidebar .nav-item", { timeout: 15_000 });
  // Lands on Treatment with the anchored row present (the resolver scrolls + flashes it).
  await expect(navRow(fresh, "Treatment")).toHaveClass(/active/);
  await expect(fresh.locator(`[id="${anchorId}"]`)).toBeVisible();
  await fresh.close();
});

// W38/5 — headline case: after a report import, the view auto-follows to it in Patient → Reports,
// highlighted, with no confirming click. The report id is the content sha's first 12 hex chars.
test("importing a report auto-navigates to it in Reports, highlighted", async ({ page }) => {
  const PDF = Buffer.from("%PDF-1.4 w38 phase5 auto-navigate fixture bytes");
  const reportId = createHash("sha256").update(PDF).digest("hex").slice(0, 12);
  const REPORT = {
    studyType: "Chest CT",
    diseases: [{ date: "2025-03-01", diagnostic: "No acute findings", summary: "Unremarkable chest CT.", confidence: 0.97 }],
    comorbidities: [],
    priorComparisons: [],
    markers: [],
  };

  await page.route("**/api/extract", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) }),
  );
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openSynthetic(page);
  const hash = `#${mySynthetic().slug}`;
  // M81 — Import's block-level sidebar button was removed; it's reachable only via the
  // top-right kebab menu now (already mirrored the same action since M78 Phase 14).
  await clickNav(page, "Reports");
  await clickLeafMenuItem(page.locator(".page-kebab"), "Import");
  await page.waitForSelector(".import-tab .dropzone", { timeout: 10_000 });
  await page.setInputFiles(".import-tab input[type=file]", { name: "chest-ct.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.locator(".import-tab .preview h3")).toHaveText("Chest CT");
  await page.click(".import-tab button.primary");

  // No further click: the modal closes, the URL points at the new report, and the row is on screen.
  await expect(page.locator(".import-tab")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${hash}/healthReports$`));
  await expect(navRow(page, "Reports")).toHaveClass(/active/);
  await expect(page.locator(`[id="report-${reportId}"]`)).toBeVisible();
});

test("Chat's own URL is its coarse location (the active thread, not a section key)", async ({ page }) => {
  await openSynthetic(page);
  const hash = `#${mySynthetic().slug}`;
  // Chat lands as the default tab and uses the active thread as its "section", so its permalink is
  // the address of the current conversation (#<client>/chat/<threadId>) rather than a section
  // key — unlike every other row. M84 removed the sidebar's per-row 🔗 button, so this now reads
  // the address bar directly instead of copying via a UI affordance that no longer exists.
  await expect(page).toHaveURL(new RegExp(`${hash}/chat/t\\d+$`));
});
