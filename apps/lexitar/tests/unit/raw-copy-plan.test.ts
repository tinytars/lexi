// The whole safety argument of a cross-store copy, held to by the only part a test can reach.
//
// Both halves of the copy need a live bucket, a live D1 and the organisation's key, so nothing
// inside either of them is testable; scripts/raw-copy-plan.ts exists precisely so the decision
// about what may be written is a pure function over four sets. The case that bought this file is
// `heal`: on 2026-11-09 a copy into production wrote 22 objects and then threw before recording
// their rows, and because `take` excludes anything already present, a re-run would have skipped
// those 22 forever. A row-only path is therefore not a convenience and is pinned here.
import { describe, it, expect } from "vitest";
import { hashDisagrees, planNamespace, type NamespaceState } from "../../scripts/raw-copy-plan";
import type { StagedEntry } from "../../scripts/raw-copy-manifest";

/** An attachment key is `${sha256.slice(0,8)}-${safeName}` (src/lib/attachment-store.ts:29-33). */
const SHA = "deadbeefcafef00d".padEnd(64, "0");
const sound = (name: string, sha = SHA): StagedEntry => ({
  slug: "ns", file: `${sha.slice(0, 8)}-${name}`, local: "f0001.bin", bytes: 1, sha256: sha,
});

const state = (over: Partial<NamespaceState> & { entries: StagedEntry[] }): NamespaceState => ({
  named: new Set(over.entries.map((e) => e.file)),
  present: new Set<string>(),
  rowed: new Set<string>(),
  keyed: new Set<string>(),
  ...over,
});

describe("hashDisagrees", () => {
  it("accepts a key whose prefix is its own content hash", () => {
    expect(hashDisagrees(sound("front.jpg"))).toBe(false);
  });

  it("refuses a key whose prefix belongs to different bytes", () => {
    const e = { ...sound("front.jpg"), sha256: "0123456789".padEnd(64, "f") };
    expect(hashDisagrees(e)).toBe(true);
  });

  it("cannot check a key that predates content addressing, and does not pretend to", () => {
    // Treating "unanswerable" as "failed" would refuse every attachment older than the scheme.
    const e: StagedEntry = { slug: "ns", file: "front.jpg", local: "f0002.bin", bytes: 1, sha256: SHA };
    expect(hashDisagrees(e)).toBe(false);
  });
});

describe("planNamespace", () => {
  it("copies a named file the target bucket does not hold", () => {
    const e = sound("front.jpg");
    const plan = planNamespace(state({ entries: [e] }));
    expect(plan.take.map((x) => x.file)).toEqual([e.file]);
    expect(plan.heal).toEqual([]);
    expect(plan.odd).toEqual([]);
    expect(plan.gap).toEqual([e.file]);
  });

  it("never writes bytes the target's record does not name", () => {
    // Bytes nothing in production ever fetches are a disclosure with no reader.
    const e = sound("front.jpg");
    const plan = planNamespace(state({ entries: [e], named: new Set<string>() }));
    expect(plan.take).toEqual([]);
    expect(plan.heal).toEqual([]);
    expect(plan.gap).toEqual([]);
  });

  it("reports a hash disagreement and copies nothing for it", () => {
    const e = { ...sound("front.jpg"), sha256: "0123456789".padEnd(64, "f") };
    const plan = planNamespace(state({ entries: [e] }));
    expect(plan.odd.map((x) => x.file)).toEqual([e.file]);
    expect(plan.take).toEqual([]);
    expect(plan.heal).toEqual([]);
  });

  it("heals a present object whose row never landed, and does not re-copy it", () => {
    // The 2026-11-09 failure: 22 objects sealed with their keys saved, zero rows, and `take`
    // excludes anything present — so without `heal` those objects stay invisible permanently.
    const e = sound("front.jpg");
    const plan = planNamespace(state({
      entries: [e], present: new Set([e.file]), keyed: new Set([e.file]),
    }));
    expect(plan.heal.map((x) => x.file)).toEqual([e.file]);
    expect(plan.take).toEqual([]);
    expect(plan.gap).toEqual([]);
  });

  it("leaves a present, unrowed object alone when the ring holds no key for it", () => {
    // A row for an object nothing can open turns a silent omission into a failed fetch.
    const e = sound("front.jpg");
    const plan = planNamespace(state({ entries: [e], present: new Set([e.file]) }));
    expect(plan.heal).toEqual([]);
    expect(plan.take).toEqual([]);
  });

  it("does nothing for a file that is already present and already rowed", () => {
    const e = sound("front.jpg");
    const plan = planNamespace(state({
      entries: [e], present: new Set([e.file]), rowed: new Set([e.file]), keyed: new Set([e.file]),
    }));
    expect(plan.take).toEqual([]);
    expect(plan.heal).toEqual([]);
    expect(plan.odd).toEqual([]);
    expect(plan.gap).toEqual([]);
  });

  it("reports the named files staging cannot answer for", () => {
    // `gap` minus `take` is the residue: a file the source never held, or one this lane does not
    // carry (a PDF). A number rather than a silence.
    const e = sound("front.jpg");
    const plan = planNamespace(state({
      entries: [e], named: new Set([e.file, "report.pdf", "99999999-scan.png"]),
    }));
    expect(plan.take.map((x) => x.file)).toEqual([e.file]);
    expect([...plan.gap].sort()).toEqual([e.file, "99999999-scan.png", "report.pdf"].sort());
  });

  it("preserves staged order within each set", () => {
    const a = sound("a.jpg");
    const b = sound("b.jpg", "11223344".padEnd(64, "0"));
    const plan = planNamespace(state({ entries: [b, a] }));
    expect(plan.take.map((x) => x.file)).toEqual([b.file, a.file]);
  });
});
