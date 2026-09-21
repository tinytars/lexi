import { describe, it, expect } from "vitest";
import { fillStatement } from "../../scripts/raw-pages-backfill";

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
