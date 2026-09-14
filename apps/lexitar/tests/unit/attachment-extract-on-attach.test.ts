import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// attachFiles is the one path every leaf's Attach goes through, and this file covers what the
// documents milestone added to it: the page cap that runs BEFORE the upload, and the read-once
// extraction whose result is stamped onto the returned Attachment. Both are mocked at the module
// boundary — pdfjs and a live model call have no business in a unit test.
const { openPdf, extractDocument } = vi.hoisted(() => ({ openPdf: vi.fn(), extractDocument: vi.fn() }));
vi.mock("@tinytars/frame/pdf-render", () => ({ openPdf }));
vi.mock("../../src/lib/document-extract-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/document-extract-client")>()),
  extractDocument,
}));

import { attachFiles, hasExtractedText } from "../../src/lib/attachment-store";
import { MAX_DOCUMENT_PAGES } from "@pablotech/akesi-pil/document-read";

const pdf = (name = "report.pdf") => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: "application/pdf" });

beforeEach(() => {
  openPdf.mockReset();
  openPdf.mockResolvedValue({ numPages: 3 });
  extractDocument.mockReset();
  extractDocument.mockResolvedValue({
    at: "2026-08-19T00:00:00Z", chars: 1234, documentKind: "Radiology report", isMedicalReport: true, text: "IMPRESSION: ...",
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("attachFiles — reading a document at attach time", () => {
  it("stamps extraction metadata onto the attachment, and keeps the TEXT out of it", async () => {
    const [a] = await attachFiles("Alex", [pdf()]);
    expect(a.extracted).toEqual({ at: "2026-08-19T00:00:00Z", chars: 1234, kind: "Radiology report" });
    expect(JSON.stringify(a)).not.toContain("IMPRESSION");
    expect(hasExtractedText(a)).toBe(true);
  });

  it("reads a document exactly once per attach", async () => {
    await attachFiles("alex", [pdf("a.pdf"), pdf("b.pdf")]);
    expect(extractDocument).toHaveBeenCalledTimes(2);
  });

  it("never tries to read an image", async () => {
    const [a] = await attachFiles("alex", [new File([new Uint8Array([1])], "rash.jpg", { type: "image/jpeg" })]);
    expect(extractDocument).not.toHaveBeenCalled();
    expect(a.extracted).toBeUndefined();
    expect(hasExtractedText(a)).toBe(false);
  });

  it("records a failed read instead of failing the attach — the file is already uploaded", async () => {
    extractDocument.mockRejectedValueOnce(new Error("The AI is busy right now — try again in a moment."));
    const [a] = await attachFiles("alex", [pdf()]);
    expect(a.key).toMatch(/^[0-9a-f]{8}-report\.pdf$/);
    expect(a.extracted?.error).toMatch(/busy/);
    expect(hasExtractedText(a)).toBe(false);
  });

  it("skips extraction entirely when the caller opts out", async () => {
    const [a] = await attachFiles("alex", [pdf()], { extractDocuments: false });
    expect(extractDocument).not.toHaveBeenCalled();
    expect(a.extracted).toBeUndefined();
  });
});

describe("attachFiles — the page cap", () => {
  it("refuses an over-long PDF BEFORE uploading or reading it", async () => {
    openPdf.mockResolvedValueOnce({ numPages: MAX_DOCUMENT_PAGES + 1 });
    await expect(attachFiles("alex", [pdf("huge.pdf")])).rejects.toThrow(new RegExp(`${MAX_DOCUMENT_PAGES + 1} pages`));
    expect(fetch).not.toHaveBeenCalled();
    expect(extractDocument).not.toHaveBeenCalled();
  });

  it("accepts a PDF exactly at the cap", async () => {
    openPdf.mockResolvedValueOnce({ numPages: MAX_DOCUMENT_PAGES });
    await expect(attachFiles("alex", [pdf()])).resolves.toHaveLength(1);
  });

  it("lets a PDF pdfjs cannot open through — the reader may still manage it", async () => {
    openPdf.mockRejectedValueOnce(new Error("bad xref"));
    const [a] = await attachFiles("alex", [pdf()]);
    expect(a.name).toBe("report.pdf");
  });

  it("does not page-count a non-PDF", async () => {
    await attachFiles("alex", [new File([new Uint8Array([1])], "n.txt", { type: "text/plain" })]);
    expect(openPdf).not.toHaveBeenCalled();
  });
});

describe("attachFiles — the page cap must not consume the bytes it counts", () => {
  it("uploads the full file after a page count, even though pdf.js detaches what it is given", async () => {
    // The real failure, reproduced: pdf.js TRANSFERS the array it receives to its worker, which
    // detaches the underlying ArrayBuffer. Handing it the same array we upload left the PUT with a
    // zero-length body and /api/raw answered 400 — "storing the attachment failed (400)" on every
    // PDF. structuredClone-with-transfer detaches exactly the way pdf.js does.
    openPdf.mockImplementationOnce(async (bytes: Uint8Array) => {
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      return { numPages: 3 };
    });
    const uploaded: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init?.method === "PUT") uploaded.push((init.body as Uint8Array).byteLength);
      return new Response(null, { status: 204 });
    }));

    const file = pdf();
    const [a] = await attachFiles("alex", [file]);
    expect(uploaded).toEqual([file.size]);
    expect(a.bytes).toBe(file.size);
  });
});
