import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { documentTextsFor, isExtractableDocument, isPdfAttachment, extractedMetadata } from "../../src/lib/document-extract-client";
import { MAX_DOCUMENT_CHARS, MAX_DOCUMENTS_TOTAL_CHARS } from "@pablotech/akesi/document-read";
import type { Attachment } from "../../src/lib/types";

const att = (name: string, mediaType: string): Attachment => ({ key: `k-${name}`, name, mediaType, bytes: 1, addedAt: "" });

describe("isExtractableDocument", () => {
  it("accepts PDFs by media type and by extension", () => {
    expect(isExtractableDocument(att("a.pdf", "application/pdf"))).toBe(true);
    expect(isExtractableDocument(att("a.pdf", "application/octet-stream"))).toBe(true);
    expect(isPdfAttachment(att("a.pdf", "application/octet-stream"))).toBe(true);
  });

  it("accepts plain text and markdown", () => {
    expect(isExtractableDocument(att("n.txt", "text/plain"))).toBe(true);
    expect(isExtractableDocument(att("n.md", "application/octet-stream"))).toBe(true);
  });

  it("refuses images and spreadsheets — an image is vision, a spreadsheet is a marker import", () => {
    expect(isExtractableDocument(att("p.jpg", "image/jpeg"))).toBe(false);
    expect(isExtractableDocument(att("labs.xlsx", "application/vnd.ms-excel"))).toBe(false);
  });
});

describe("extractedMetadata", () => {
  it("keeps the text OUT of the vault — metadata only", () => {
    const meta = extractedMetadata({
      at: "2026-08-19T00:00:00Z", chars: 42, documentKind: "Lab results", isMedicalReport: true, text: "a".repeat(42),
    });
    expect(meta).toEqual({ at: "2026-08-19T00:00:00Z", chars: 42, kind: "Lab results" });
    expect(JSON.stringify(meta)).not.toContain("aaa");
  });
});

describe("documentTextsFor", () => {
  const sidecars = new Map<string, { text: string } | null>();

  beforeEach(() => {
    sidecars.clear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const key = decodeURIComponent(new URL(url, "http://local").searchParams.get("key") ?? "");
      const hit = sidecars.get(key);
      if (!hit) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ ...hit, at: "now", chars: hit.text.length, documentKind: "x", isMedicalReport: false }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns nothing when no attachment is a readable document", async () => {
    expect(await documentTextsFor("alex", [att("p.jpg", "image/jpeg")])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns each extracted document's text, named", async () => {
    sidecars.set("k-a.pdf", { text: "LDL 120" });
    sidecars.set("k-b.txt", { text: "felt tired" });
    const out = await documentTextsFor("alex", [att("a.pdf", "application/pdf"), att("b.txt", "text/plain")]);
    expect(out).toEqual([{ name: "a.pdf", text: "LDL 120" }, { name: "b.txt", text: "felt tired" }]);
  });

  it("silently drops a document that was never extracted, rather than failing the turn", async () => {
    sidecars.set("k-a.pdf", { text: "LDL 120" });
    const out = await documentTextsFor("alex", [att("a.pdf", "application/pdf"), att("missing.pdf", "application/pdf")]);
    expect(out.map((d) => d.name)).toEqual(["a.pdf"]);
  });

  it("truncates an enormous document and SAYS SO, so it is never read as complete", async () => {
    sidecars.set("k-huge.pdf", { text: "x".repeat(MAX_DOCUMENT_CHARS + 5_000) });
    const [doc] = await documentTextsFor("alex", [att("huge.pdf", "application/pdf")]);
    expect(doc.text.length).toBeLessThan(MAX_DOCUMENT_CHARS + 200);
    expect(doc.text).toContain("document truncated here");
  });

  it("stops once the total budget is spent instead of assembling an over-cap request", async () => {
    // Distinct names from every other test in this file: extracted text is cached in-module by
    // content key (safe, since keys are content-addressed), so reusing a name would serve the
    // short text an earlier test cached and the budget would never be reached.
    const names = ["big1", "big2", "big3", "big4"].map((n) => `${n}.pdf`);
    for (const n of names) sidecars.set(`k-${n}`, { text: "y".repeat(MAX_DOCUMENT_CHARS) });
    const out = await documentTextsFor("alex", names.map((n) => att(n, "application/pdf")));
    const total = out.reduce((sum, d) => sum + d.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_DOCUMENTS_TOTAL_CHARS + out.length * 200);
    expect(out.length).toBeLessThan(names.length);
  });
});
