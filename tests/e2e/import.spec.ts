import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import * as XLSX from "xlsx";
import { openPatient } from "./_login";
import { clickNav } from "./_nav";
import { clickLeafMenuItem } from "./_leaf-menu";

// A real HealthMatters-shaped .xlsx (section-header row + data rows) the browser folds inline.
function healthmattersXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Chemistry Panel", "Unit", "Reference", "2026-07-04"],
      ["Glucose", "mg/dL", "70-100", 92],
      ["Creatinine", "mg/dL", "0.7-1.3", 0.9],
    ]),
    "Results",
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// W15/1 — browser report upload. Drop a PDF → /api/extract (mocked, no live Anthropic)
// → preview → commit → /api/raw PUT (mocked) + vault save (intercepted; NO disk write).
// Then a re-upload of the same bytes is detected as a duplicate (content-hash dedup).

const REPORT = {
  studyType: "Coronary CTA",
  diseases: [{ date: "2019-04-02", diagnostic: "CAC: 210; CAD-RADS 3 in the Proximal RCA", summary: "Total CAC 210; proximal RCA calcified plaque, CAD-RADS 3.", confidence: 0.95 }],
  comorbidities: [],
  priorComparisons: [],
  markers: [{ marker: "Coronary artery calcium (CAC) score", value: 210, unit: "", date: "2019-04-02", group: "Cardiac Imaging", confidence: 0.98 }],
};

const PDF = Buffer.from("%PDF-1.4 e2e fake report bytes");

async function openImport(page: Page) {
  await openPatient(page);
  // M81 — Import's block-level sidebar button was removed; it's reachable only via the
  // top-right kebab menu now (already mirrored the same action since M78 Phase 14).
  await clickNav(page, "Reports");
  await clickLeafMenuItem(page.locator(".page-kebab"), "Import");
  await page.waitForSelector(".import-tab .dropzone", { timeout: 10_000 });
}

test("drop a PDF → preview → commit stores the raw + saves the vault", async ({ page }) => {
  let extractCalled = false;
  let rawPut = false;
  let vaultSaved = false;

  await page.route("**/api/extract", (route) => {
    extractCalled = true;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) });
  });
  await page.route("**/api/raw/**", (route) => {
    if (route.request().method() === "PUT") rawPut = true;
    route.fulfill({ status: 204, body: "" });
  });
  // Disk safety: capture the re-encrypted blob, never write to R2. Scope to PUT — GET
  // still needs the real vault (served during login/dashboard load).
  await page.route("**/api/vault/**", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    vaultSaved = true;
    route.fulfill({ status: 204, body: "" });
  });

  await openImport(page);
  await page.setInputFiles(".import-tab input[type=file]", { name: "coronary.pdf", mimeType: "application/pdf", buffer: PDF });

  // Phase-1 preview: the study + the fold summary appear after extraction.
  await expect(page.locator(".import-tab .preview h3")).toHaveText("Coronary CTA");
  await expect(page.locator(".import-tab .preview .summary")).toContainText("Diagnoses:");
  expect(extractCalled).toBe(true);

  // W38/5 — a committed report auto-navigates: the modal closes and the view follows to Reports.
  await page.click(".import-tab button.primary");
  await expect(page.locator(".import-tab")).toHaveCount(0);
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Reports" })).toHaveClass(/active/);
  expect(rawPut).toBe(true);
  expect(vaultSaved).toBe(true);
});

test("re-uploading the same bytes is a duplicate no-op", async ({ page }) => {
  await page.route("**/api/extract", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) }),
  );
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openImport(page);
  await page.setInputFiles(".import-tab input[type=file]", { name: "coronary.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.click(".import-tab button.primary");
  // W38/5 — commit auto-navigates and closes the modal.
  await expect(page.locator(".import-tab")).toHaveCount(0);

  // The folded source is now in the in-memory vault; re-open Import and drop the same bytes —
  // they hash identically and are flagged as a duplicate.
  await clickLeafMenuItem(page.locator(".page-kebab"), "Import");
  await page.waitForSelector(".import-tab .dropzone", { timeout: 10_000 });
  await page.setInputFiles(".import-tab input[type=file]", { name: "coronary.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.locator(".import-tab .note.dup")).toContainText("Already on file");
});

test("a non-PDF is accepted into the ~24h pending queue (no extractor call)", async ({ page }) => {
  let extractCalled = false;
  let rawPut = false;
  await page.route("**/api/extract", (route) => { extractCalled = true; route.fulfill({ status: 200, body: "{}" }); });
  await page.route("**/api/raw/**", (route) => { if (route.request().method() === "PUT") rawPut = true; route.fulfill({ status: 204, body: "" }); });
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openImport(page);
  await page.setInputFiles(".import-tab input[type=file]", {
    name: "2026-labs.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("PK fake xlsx bytes"),
  });

  // Unparseable bytes: inline parse is attempted, fails, and falls back to the queue.
  await expect(page.locator(".import-tab .preview h3")).toHaveText("2026-labs.xlsx");
  await expect(page.locator(".import-tab .preview")).toContainText("isn't read in the browser yet");
  await page.click(".import-tab button.primary");
  await expect(page.locator(".import-tab .note.ok")).toContainText("queued");
  expect(rawPut).toBe(true);
  expect(extractCalled).toBe(false);
});

test("drop a real HealthMatters .xlsx → folds inline, no pending queue, no extractor call", async ({ page }) => {
  let extractCalled = false;
  let rawPut = false;
  let vaultSaved = false;
  await page.route("**/api/extract", (route) => { extractCalled = true; route.fulfill({ status: 200, body: "{}" }); });
  await page.route("**/api/raw/**", (route) => { if (route.request().method() === "PUT") rawPut = true; route.fulfill({ status: 204, body: "" }); });
  await page.route("**/api/vault/**", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    vaultSaved = true;
    route.fulfill({ status: 204, body: "" });
  });

  await openImport(page);
  await page.setInputFiles(".import-tab input[type=file]", {
    name: "healthmatters-2026.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: healthmattersXlsx(),
  });

  // Inline fold preview: a readings summary, NOT the "queued for processing" copy.
  await expect(page.locator(".import-tab .preview h3")).toHaveText("healthmatters-2026.xlsx");
  await expect(page.locator(".import-tab .preview .summary")).toContainText("Readings:");
  await expect(page.locator(".import-tab .preview")).not.toContainText("isn't read in the browser yet");

  await page.click(".import-tab button.primary");
  await expect(page.locator(".import-tab .note.ok")).toContainText("Added");
  await expect(page.locator(".import-tab .note.ok")).not.toContainText("queued");
  expect(rawPut).toBe(true);
  expect(vaultSaved).toBe(true);
  expect(extractCalled).toBe(false);
});

test("Reports refuses a PDF that isn't a medical report, and says what it is instead", async ({ page }) => {
  // The gate that makes the rest of this milestone safe: Chat and Notes accept any PDF for
  // discussion, which only works because Reports keeps refusing everything that isn't a report.
  await page.route("**/api/extract", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "This doesn't look like a medical report — it is a supplement package insert. Attach it to a note or a chat instead.",
        errorCode: "not_a_report",
      }),
    }),
  );
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));

  await openImport(page);
  await page.setInputFiles(".import-tab input[type=file]", { name: "insert.pdf", mimeType: "application/pdf", buffer: PDF });

  const err = page.locator(".import-tab .note.err");
  await expect(err).toContainText("supplement package insert");
  await expect(err).toContainText("Attach it to a note or a chat instead");
});
