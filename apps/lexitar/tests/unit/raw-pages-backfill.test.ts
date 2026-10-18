import { describe, it, expect } from "vitest";
import { fillStatement, purgedKeys, sidecarKeyOf } from "../../scripts/raw-pages-backfill";

// W77 — the sweep writes page counts straight into D1, bypassing every route's validation, and a
// stored count is what the corpus ceiling is then checked against. So the one thing worth pinning is
// the SQL: that it can only fill a missing count, and that a key cannot smuggle a quote into it.

describe("fillStatement", () => {
  const rows = [
    { key: "prod/raw/alex/a.pdf", pages: 3, bytes: 100 },
    { key: "prod/raw/alex/b.pdf", pages: 12, bytes: 200 },
  ];

  it("fills only rows that have no count yet", () => {
    expect(fillStatement(rows)).toMatch(/AND pages IS NULL$/);
  });

  it("pairs each key with its own count and size, and touches no other key", () => {
    const sql = fillStatement(rows);
    expect(sql).toContain("pages = CASE r2_key WHEN 'prod/raw/alex/a.pdf' THEN 3 WHEN 'prod/raw/alex/b.pdf' THEN 12 END");
    expect(sql).toContain("bytes = CASE r2_key WHEN 'prod/raw/alex/a.pdf' THEN 100 WHEN 'prod/raw/alex/b.pdf' THEN 200 END");
    expect(sql).toContain("WHERE r2_key IN ('prod/raw/alex/a.pdf', 'prod/raw/alex/b.pdf')");
  });

  it("escapes a quote in an R2 key rather than ending the literal", () => {
    const sql = fillStatement([{ key: "prod/raw/o'brien/a.pdf", pages: 1, bytes: 1 }]);
    expect(sql).toContain("'prod/raw/o''brien/a.pdf'");
  });
});

// --purge-unreadable deletes a patient's upload, so what it reaches is worth pinning even though the
// deletion itself is one deleteObject call.
describe("purgedKeys", () => {
  it("takes the transcription sidecar with the file it transcribes", () => {
    expect(sidecarKeyOf("dev/raw/liz/scan.pdf")).toBe("dev/text/liz/scan.pdf.json");
    expect(purgedKeys(["dev/raw/liz/a.pdf", "dev/raw/liz/b.pdf"])).toEqual([
      "dev/raw/liz/a.pdf",
      "dev/text/liz/a.pdf.json",
      "dev/raw/liz/b.pdf",
      "dev/text/liz/b.pdf.json",
    ]);
  });

  // The store prefix is the first segment and the client id the third, so rewriting the LAST `/raw/`
  // would rename a namespace that happens to be called "raw" instead of the segment that means it.
  it("rewrites the store's raw segment, not a client id spelled the same", () => {
    expect(sidecarKeyOf("dev/raw/raw/a.pdf")).toBe("dev/text/raw/a.pdf.json");
  });
});
