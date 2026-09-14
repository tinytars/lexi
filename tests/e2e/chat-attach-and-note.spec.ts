import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openPatient } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { stubChatHistory } from "./_stubs";

// M-chat-file-attach-and-create-note — two chat-composer actions added alongside the existing
// paste-a-permalink reference cards (chat-reference-cards.spec.ts): attaching a file from the
// Send menu's "+", and a per-turn "Annotate" action (M-annotate renamed it from "Create Note")
// that seeds Notes' Add modal. Mirrors import.spec.ts's /api/extract + /api/raw + /api/vault stub
// idiom for the attach path, and chat-reference-cards.spec.ts's reference-card assertions.

const REPORT = {
  studyType: "Coronary CTA",
  diseases: [{ date: "2019-04-02", diagnostic: "CAC: 210; CAD-RADS 3 in the Proximal RCA", summary: "Total CAC 210; proximal RCA calcified plaque, CAD-RADS 3.", confidence: 0.95 }],
  comorbidities: [],
  priorComparisons: [],
  markers: [{ marker: "Coronary artery calcium (CAC) score", value: 210, unit: "", date: "2019-04-02", group: "Cardiac Imaging", confidence: 0.98 }],
};
const PDF = Buffer.from("%PDF-1.4 e2e fake report bytes");

// What /api/document-extract returns for that PDF — the transcription every surface now reads.
const READING = {
  documentKind: "Radiology report",
  isMedicalReport: true,
  notReportReason: "",
  text: "IMPRESSION: Total CAC 210; proximal RCA calcified plaque, CAD-RADS 3.",
};

async function openClient(page: Page) {
  await stubChatHistory(page);
  await openPatient(page);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  await page.waitForTimeout(200);
}

test("attaching a PDF in chat makes it a discussable attachment, not a report import", async ({ page }) => {
  // The de-diversion. This test used to assert the opposite — that a picked PDF was swallowed by
  // the report-ingest pipeline and came back as a "Report" reference card — which meant you could
  // not talk about a document at all, the one thing a chat attachment is for.
  let extractCalled = false;
  let documentExtractCalls = 0;
  let rawPut = false;
  await page.route("**/api/extract", (route) => {
    extractCalled = true;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPORT) });
  });
  await page.route("**/api/document-extract**", (route) => {
    if (route.request().method() === "POST") documentExtractCalls += 1;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...READING, at: "2026-08-19T00:00:00Z", chars: READING.text.length, cached: false }),
    });
  });
  await page.route("**/api/raw/**", (route) => {
    if (route.request().method() === "PUT") rawPut = true;
    route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openClient(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    clickLeafMenuItem(page.locator(".chat-input"), "Attach"),
  ]);
  await chooser.setFiles({ name: "coronary.pdf", mimeType: "application/pdf", buffer: PDF });

  // It stages as an attachment chip, read once, and is NOT folded into Reports.
  const chip = page.locator(".chat-tab .attachment-chip").last();
  await expect(chip).toBeVisible();
  await expect(chip.locator(".attachment-badge.read")).toBeVisible();
  expect(documentExtractCalls).toBe(1);
  expect(rawPut).toBe(true);
  expect(extractCalled).toBe(false);
  await expect(page.locator(".reference-card")).toHaveCount(0);
});

test("a chat question carries the attached document's text to the model", async ({ page }) => {
  let sentBody = "";
  await page.route("**/api/document-extract**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...READING, at: "2026-08-19T00:00:00Z", chars: READING.text.length }),
    }),
  );
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));
  await page.route("**/api/chat", (route) => {
    sentBody = route.request().postData() ?? "";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "It reports a CAC of 210." }) });
  });

  await openClient(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    clickLeafMenuItem(page.locator(".chat-input"), "Attach"),
  ]);
  await chooser.setFiles({ name: "coronary.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.locator(".chat-tab .attachment-chip").last()).toBeVisible();

  await page.fill(".chat-tab textarea", "what does this say?");
  await page.click(".chat-tab button.send");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").last()).toHaveText("It reports a CAC of 210.");

  // The transcription rides the turn as TEXT — quotable, and not a re-sent PDF.
  expect(sentBody).toContain("BEGIN DOCUMENT: coronary.pdf");
  expect(sentBody).toContain("Total CAC 210");
});

test("a spreadsheet is still routed to the import pipeline, not staged for discussion", async ({ page }) => {
  // The one diversion that stays: a spreadsheet is a marker import and nothing a conversation can
  // do anything with.
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openClient(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    clickLeafMenuItem(page.locator(".chat-input"), "Attach"),
  ]);
  await chooser.setFiles({ name: "labs.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: PDF });

  await expect(page.locator(".reference-card").last()).toBeVisible();
  await expect(page.locator(".chat-tab .attachment-chip")).toHaveCount(0);
});

test("chat accepts a file type it cannot read — it attaches, it does not refuse", async ({ page }) => {
  // "Chat should allow me to attach anything." A .docx has no parser in the tree, so nothing can be
  // read out of it — that is a reason for the turn to carry no text, never a reason to reject the
  // file. Reports is the only surface that refuses anything.
  let documentExtractCalled = false;
  await page.route("**/api/document-extract**", (route) => {
    documentExtractCalled = true;
    route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: "x", errorCode: "unsupported_document" }) });
  });
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/vault/**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue()));

  await openClient(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    clickLeafMenuItem(page.locator(".chat-input"), "Attach"),
  ]);
  await chooser.setFiles({
    name: "protocol.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("PK fake docx bytes"),
  });

  await expect(page.locator(".chat-tab .attachment-chip")).toHaveCount(1);
  await expect(page.locator(".chat-tab .chat-error")).toHaveCount(0);
  // Not even attempted — an unreadable type never reaches the reader.
  expect(documentExtractCalled).toBe(false);
});

test("a chat turn's 'Annotate' action seeds Notes' Add modal with a reference back to that turn", async ({ page }) => {
  await openClient(page);

  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "Your gradient rose from 10 to 14." }) }),
  );
  await page.fill(".chat-tab textarea", "what changed since my last echo?");
  await page.click(".chat-tab button.send");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").last()).toHaveText("Your gradient rose from 10 to 14.");

  const turnCard = page.locator(".chat-tab .leaf-card").last();
  await clickLeafMenuItem(turnCard, "Annotate");

  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Notes" })).toHaveClass(/active/);
  await expect(page.locator(".nt-modal")).toBeVisible();
  const attached = page.locator(".nt-modal .reference-card");
  await expect(attached).toBeVisible();
  await expect(attached.locator(".reference-tag")).toHaveText("Chat");
  await expect(attached.locator(".reference-title")).toHaveText("what changed since my last echo?");

  await page.fill(".nt-modal textarea.note-input", "Follow up on this at the next visit.");
  await page.click(".nt-modal button.primary");
  await expect(page.locator(".nt-modal")).toHaveCount(0);

  // The saved note keeps the attachment visible in the read view too (NoteRow/noteRow's
  // {#if n.attachment} branch).
  const savedCard = page.locator(".notes .reference-card").last();
  await expect(savedCard).toBeVisible();
  await expect(savedCard.locator(".reference-tag")).toHaveText("Chat");
});
