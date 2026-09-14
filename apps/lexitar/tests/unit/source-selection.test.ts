import { describe, it, expect } from "vitest";
import { resolveSourceToken, ingestDecision, extractionSource } from "../../src/lib/source-selection";

// W76 — the first tests over `npm run ingest`'s source commands (plan item 18).
//
// scripts/commands/* is 1,183 lines at zero coverage, all of it vault-mutating. What is asserted here
// is the part that decides WHICH record is affected and whether work is redone — not the fs and LLM
// shell around it, which is the same line ingest-core.ts draws against ingest.ts.

const basename = (p: string) => p.split("/").pop() ?? p;

const src = (id: string, file: string, originalName: string) => ({ id, file, originalName });
const SOURCES = [
  src("a1b2c3d4e5", "records/private/liz/raw/2024-labs.xlsx", "Quest 2024.xlsx"),
  src("a1b2c3ffff", "records/private/liz/raw/2025-labs.xlsx", "Quest 2025.xlsx"),
  src("99887766", "records/private/liz/raw/dexa.pdf", "DEXA.pdf"),
];

describe("naming the source to remove", () => {
  it("resolves a full id, a stored filename, and an original filename", () => {
    expect(resolveSourceToken(SOURCES, "99887766", basename)).toEqual({ kind: "one", source: SOURCES[2] });
    expect(resolveSourceToken(SOURCES, "dexa.pdf", basename)).toEqual({ kind: "one", source: SOURCES[2] });
    expect(resolveSourceToken(SOURCES, "DEXA.pdf", basename)).toEqual({ kind: "one", source: SOURCES[2] });
  });

  it("resolves a prefix long enough to be one", () => {
    expect(resolveSourceToken(SOURCES, "a1b2c3d", basename)).toEqual({ kind: "one", source: SOURCES[0] });
  });

  it("REFUSES a prefix that names two sources instead of quietly taking the first", () => {
    // The defect this file exists for. Removing a source drops every reading only it attested, so
    // silently picking whichever came first in the array is a data loss chosen by array order.
    const r = resolveSourceToken(SOURCES, "a1b2c3", basename);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.matches).toEqual([SOURCES[0], SOURCES[1]]);
  });

  it("does not treat a too-short fragment as a prefix at all", () => {
    // Under a 1-char prefix rule, "a" would name half the vault.
    expect(resolveSourceToken(SOURCES, "a1b2", basename).kind).toBe("none");
  });

  it("lets an exact match stand even when it also reads as an ambiguous prefix", () => {
    const shadowed = [src("a1b2c3", "raw/x.pdf", "X.pdf"), ...SOURCES];
    expect(resolveSourceToken(shadowed, "a1b2c3", basename)).toEqual({ kind: "one", source: shadowed[0] });
  });

  it("reports an unknown or empty token as no match, which the caller treats as a no-op", () => {
    expect(resolveSourceToken(SOURCES, "nope-nothing", basename).kind).toBe("none");
    expect(resolveSourceToken(SOURCES, "   ", basename).kind).toBe("none");
    expect(resolveSourceToken([], "a1b2c3d4e5", basename).kind).toBe("none");
  });
});

describe("ingesting bytes that have been seen before", () => {
  it("skips a duplicate unless --force, and never skips a file that is genuinely new", () => {
    expect(ingestDecision(true, false)).toBe("skip-duplicate");
    expect(ingestDecision(true, true)).toBe("reingest");
    expect(ingestDecision(false, false)).toBe("fresh");
    expect(ingestDecision(false, true)).toBe("fresh");
  });
});

describe("where a report extraction comes from", () => {
  it("prefers what the record was actually built from", () => {
    expect(extractionSource(true, true, false)).toBe("vault");
  });

  it("reuses the previewed extraction, so an apply cannot differ from the dry-run that preceded it", () => {
    // The dry-run writes its extraction to the disk cache precisely so the apply does not pay for a
    // second, differently-worded LLM call and then commit a different reading of the same PDF.
    expect(extractionSource(false, true, false)).toBe("disk-cache");
  });

  it("calls out only when there is nothing to reuse", () => {
    expect(extractionSource(false, false, false)).toBe("fresh");
  });

  it("lets --force override both caches, which is the only thing it is for", () => {
    expect(extractionSource(true, true, true)).toBe("fresh");
  });
});
