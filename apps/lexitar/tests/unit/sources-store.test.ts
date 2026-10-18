import { describe, it, expect } from "vitest";
import { hashSource, formatDate, dateSegment, slugStudyType, subtypeFor, storedName, findSourceBySha, upsertSourceRecord } from "../../scripts/sources-store";
import type { Client, SourceRecord } from "../../src/lib/types";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("hashSource", () => {
  it("is stable, 12-char id, distinct for distinct bytes", () => {
    const a = hashSource(bytes("hello"));
    expect(a.sha256).toBe(hashSource(bytes("hello")).sha256);
    expect(a.id).toBe(a.sha256.slice(0, 12));
    expect(a.sha256).not.toBe(hashSource(bytes("world")).sha256);
  });
});

describe("formatDate / dateSegment", () => {
  it("formats a date as YYYYMonthDD with full month, zero-padded day", () => {
    expect(formatDate("2026-05-19")).toBe("2026May19");
    expect(formatDate("2021-10-05")).toBe("2021October05");
  });
  it("collapses a single date and spans a range", () => {
    expect(dateSegment(["2021-10-15"])).toBe("2021October15");
    expect(dateSegment(["2026-05-19", "2025-09-02", "2025-12-03"])).toBe("2025September02-2026May19");
  });
});

describe("slugStudyType / subtypeFor", () => {
  it("slugs imaging study types to the region word", () => {
    expect(slugStudyType("Renal Ultrasound")).toBe("renal");
    expect(slugStudyType("Coronary CTA")).toBe("coronary");
    expect(slugStudyType("Abdominal Ultrasound")).toBe("abdominal");
    expect(slugStudyType("Transthoracic Echocardiogram")).toBe("echo");
  });
  it("gives generic subtypes for non-imaging kinds", () => {
    expect(subtypeFor("lab")).toBe("panel");
    expect(subtypeFor("dexa")).toBe("bodycomp");
    expect(subtypeFor("scale")).toBe("inbody");
    expect(subtypeFor("imaging", "Renal Ultrasound")).toBe("renal");
  });
});

describe("storedName", () => {
  it("builds <date>-<type>-<subtype>-<sha8>.<ext>", () => {
    const sha = "13da11c4a48a0000";
    expect(storedName({ sha256: sha, kind: "imaging", subtype: "coronary", dates: ["2021-10-15"], ext: ".pdf" }))
      .toBe("2021October15-imaging-coronary-13da11c4.pdf");
    expect(storedName({ sha256: sha, kind: "lab", subtype: "panel", dates: ["2025-09-02", "2026-05-19"], ext: ".xlsx" }))
      .toBe("2025September02-2026May19-blood-panel-13da11c4.xlsx");
  });
});

describe("registry ops", () => {
  it("finds by sha and upserts by id", () => {
    const c: Client = { displayName: "T", dob: "1980-01-01", gender: "male", watchlist: [], results: [] };
    const rec: SourceRecord = { id: "id1", sha256: "sha1", kind: "lab", file: "sources/p/x.xlsx", originalName: "x.xlsx", importedAt: "2026-06-08T00:00:00Z" };
    upsertSourceRecord(c, rec);
    expect(findSourceBySha(c, "sha1")!.id).toBe("id1");
    upsertSourceRecord(c, { ...rec, sha256: "sha2" });
    expect(c.sources).toHaveLength(1);
    expect(c.sources![0].sha256).toBe("sha2");
  });
});
