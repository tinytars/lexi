// W72 item 19 — the regen log.
//
// The append itself is four lines; what these tests protect is the SHAPE, which is the part that
// cannot be changed later. Append-only, no defaulted trigger, no invented cause, and a before/after
// pair that is genuinely comparable. Every one of those is cheap to hold now and impossible to
// retrofit onto a year of records written the wrong way.

import { describe, it, expect } from "vitest";
import { appendRegenEvent, changedFindingKeys } from "../../src/lib/regen-log";
import { BRAIN_VERSIONS } from "../../src/lib/brain-versions";
import type { Client, ClientFinding } from "../../src/lib/types";

const finding = (over: Partial<ClientFinding> = {}) =>
  ({ generatedAt: "2026-01-01T00:00:00Z", inputsHash: "h", ...over }) as ClientFinding;

const client = (f: ClientFinding | undefined, over: Partial<Client> = {}) =>
  ({ displayName: "p", dob: "1980-01-01", gender: "male", watchlist: [], results: [], finding: f, ...over }) as Client;

describe("changedFindingKeys", () => {
  it("reports only the sections the merge actually rewrote", () => {
    const rows = [{ noteId: "n1", result: "a", group: "g" }];
    const before = finding({ noteResults: rows, treatmentGroups: [] });
    const after = { ...before, noteResults: [{ noteId: "n1", result: "b", group: "g" }] };
    expect(changedFindingKeys(before, after)).toEqual(["noteResults"]);
  });

  it("relies on the merges being immutable, not on deep equality", () => {
    // A merge that returns a NEW array with the same contents has still rewritten the section — the
    // model answered again. Reference comparison is the exact test here, and a deep-equality version
    // of this function would silently drop those events.
    const rows = [{ noteId: "n1", result: "a", group: "g" }];
    const before = finding({ noteResults: rows });
    expect(changedFindingKeys(before, { ...before, noteResults: [...rows] })).toEqual(["noteResults"]);
    expect(changedFindingKeys(before, { ...before, noteResults: rows })).toEqual([]);
  });

  it("ignores the provenance fields every merge stamps", () => {
    const before = finding({ noteResults: [] });
    const after = {
      ...before,
      basis: { noteResults: "x" } as ClientFinding["basis"],
      nodeHashes: { noteResults: "abc" },
      promptVersions: { noteResults: "def" },
      generatedAt: "2026-02-02T00:00:00Z",
    };
    expect(changedFindingKeys(before, after)).toEqual([]);
  });

  it("treats a section that appeared or vanished as changed", () => {
    const before = finding({});
    expect(changedFindingKeys(before, { ...before, noteResults: [] })).toEqual(["noteResults"]);
    expect(changedFindingKeys({ ...before, noteResults: [] }, before)).toEqual(["noteResults"]);
  });
});

describe("appendRegenEvent", () => {
  const before = client(finding({ noteResults: [{ noteId: "n1", result: "old", group: "g" }] }));
  const after = client(finding({ noteResults: [{ noteId: "n1", result: "new", group: "g" }] }));

  it("records a comparable before and after for the section that moved", () => {
    const out = appendRegenEvent(before, after, "noteResults", "translate", "2026-03-03T00:00:00Z");
    expect(out.regenLog).toHaveLength(1);
    const e = out.regenLog![0];
    expect(e).toMatchObject({ at: "2026-03-03T00:00:00Z", node: "noteResults", triggeredBy: "translate", sections: ["noteResults"] });
    expect(e.before).toEqual({ noteResults: [{ noteId: "n1", result: "old", group: "g" }] });
    expect(e.after).toEqual({ noteResults: [{ noteId: "n1", result: "new", group: "g" }] });
  });

  it("stamps the brain version, so an event can be joined to the reasoning that produced it", () => {
    const out = appendRegenEvent(before, after, "noteResults", "translate");
    expect(out.regenLog![0].brainVersion).toBe(BRAIN_VERSIONS.noteResults);
  });

  it("omits the brain version rather than guessing when the node has none", () => {
    const out = appendRegenEvent(before, after, "notARegisteredNode", "translate");
    expect(out.regenLog![0].brainVersion).toBeUndefined();
    expect("brainVersion" in out.regenLog![0]).toBe(false);
  });

  it("appends without touching, reordering or dropping what is already there", () => {
    const seeded = { ...after, regenLog: [{ at: "old", node: "n", triggeredBy: "refresh" as const, sections: [], before: {}, after: {} }] };
    const out = appendRegenEvent(before, seeded, "noteResults", "translate");
    expect(out.regenLog).toHaveLength(2);
    expect(out.regenLog![0].at).toBe("old");
    expect(out.regenLog![1].node).toBe("noteResults");
    // The prior array is not reused, so a later append cannot mutate a Client someone else still holds.
    expect(out.regenLog).not.toBe(seeded.regenLog);
    expect(seeded.regenLog).toHaveLength(1);
  });

  it("has no cap — the hundredth event is kept alongside the first", () => {
    // A retention trim would delete the long baseline at exactly the moment it became useful, and it
    // would do so silently. If size ever binds, the log moves out of the vault; it does not shrink.
    let c = after;
    for (let i = 0; i < 100; i++) c = appendRegenEvent(before, { ...c, finding: finding({ noteResults: [{ noteId: "n1", result: `r${i}`, group: "g" }] }) }, "noteResults", "refresh");
    expect(c.regenLog).toHaveLength(100);
    expect(c.regenLog![0].after).toEqual({ noteResults: [{ noteId: "n1", result: "r0", group: "g" }] });
  });

  it("writes nothing when the merge rewrote nothing", () => {
    const same = client(before.finding);
    expect(appendRegenEvent(before, same, "noteResults", "translate").regenLog).toBeUndefined();
  });

  it("does not mutate either client it is given", () => {
    const b = client(finding({ noteResults: [] }));
    const a = client(finding({ noteResults: [{ noteId: "n1", result: "x", group: "g" }] }));
    appendRegenEvent(b, a, "noteResults", "refresh");
    expect(b.regenLog).toBeUndefined();
    expect(a.regenLog).toBeUndefined();
  });

  it("carries the whole log through unrelated fields of the returned client", () => {
    const out = appendRegenEvent(before, { ...after, factorsHash: "fh" }, "noteResults", "refresh");
    expect(out.factorsHash).toBe("fh");
    expect(out.finding).toBe(after.finding);
  });
});
