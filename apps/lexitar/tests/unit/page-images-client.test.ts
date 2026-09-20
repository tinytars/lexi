import { describe, it, expect, vi, beforeEach } from "vitest";

// The browser half of the page-image route: which body each client sends. pdf-pages-for-model is
// mocked because the decision is config-driven and the rendering needs pdfjs and a real canvas —
// page-images.test.ts covers the decision itself against real configs.
const { needsPageImages, renderPdfPages, renderOpenPdfPages } = vi.hoisted(() => ({
  needsPageImages: vi.fn(() => false),
  renderPdfPages: vi.fn(async () => PAGES),
  renderOpenPdfPages: vi.fn(async () => PAGES),
}));
vi.mock("../../src/lib/pdf-pages-for-model", () => ({ needsPageImages, renderPdfPages, renderOpenPdfPages }));
vi.mock("@tinytars/frame/pdf-render", () => ({ openPdf: vi.fn(async () => ({ numPages: 2 })) }));

import { extractReport } from "../../src/lib/extract-client";
import { attachFiles } from "../../src/lib/attachment-store";
import type { PageImage } from "@pablotech/akesi/report-extract";

const PAGES: PageImage[] = [{ base64: "AAA", mediaType: "image/jpeg" }, { base64: "BBB", mediaType: "image/jpeg" }];
const PATIENT = { dob: "1980-01-01", gender: "male" as const, factors: { diseases: [] } };
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function bodyOf(call: number) {
  return JSON.parse((vi.mocked(fetch).mock.calls[call][1] as RequestInit).body as string);
}

beforeEach(() => {
  needsPageImages.mockReset().mockReturnValue(false);
  renderPdfPages.mockClear();
  renderOpenPdfPages.mockClear();
});

describe("extractReport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ studyType: "x" }), { status: 200 })));
  });

  it("sends the PDF when the configured model reads PDFs", async () => {
    await extractReport(PDF_BYTES, "report.pdf", PATIENT);
    expect(bodyOf(0)).toMatchObject({ sourceFile: "report.pdf", pdfBase64: "JVBERg==" });
    expect(renderPdfPages).not.toHaveBeenCalled();
  });

  it("sends rendered pages, and no PDF, when it can only see", async () => {
    needsPageImages.mockReturnValue(true);
    await extractReport(PDF_BYTES, "report.pdf", PATIENT);
    const body = bodyOf(0);
    expect(body.pageImages).toEqual(PAGES);
    expect(body.pdfBase64).toBeUndefined();
    expect(needsPageImages).toHaveBeenCalledWith("extract");
  });
});

describe("attaching a PDF", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).startsWith("/api/document-extract")
          ? new Response(JSON.stringify({ at: "now", chars: 3, documentKind: "Lab report", isMedicalReport: true, text: "abc" }), { status: 200 })
          : new Response(null, { status: 204 }),
      ),
    );
  });

  it("renders from the document already opened for the page count — the PDF is not parsed twice", async () => {
    needsPageImages.mockReturnValue(true);
    await attachFiles("Alex", [new File([PDF_BYTES], "report.pdf", { type: "application/pdf" })]);
    expect(renderOpenPdfPages).toHaveBeenCalledTimes(1);
    expect(renderPdfPages).not.toHaveBeenCalled();
    const extract = vi.mocked(fetch).mock.calls.findIndex((c) => String(c[0]).startsWith("/api/document-extract"));
    expect(bodyOf(extract).pageImages).toEqual(PAGES);
  });

  it("sends no pages at all when the document model takes PDFs itself", async () => {
    await attachFiles("Alex", [new File([PDF_BYTES], "report.pdf", { type: "application/pdf" })]);
    expect(renderOpenPdfPages).not.toHaveBeenCalled();
    const extract = vi.mocked(fetch).mock.calls.findIndex((c) => String(c[0]).startsWith("/api/document-extract"));
    expect(bodyOf(extract).pageImages).toBeUndefined();
  });
});
