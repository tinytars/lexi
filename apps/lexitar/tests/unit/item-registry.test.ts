import { describe, it, expect } from "vitest";
import { itemRecordId, isItemPinned, isPinnedItem, toggleItemPin, pinnedItems } from "@pablotech/akesi/item-registry";
import { togglePinnedIn, isPinnedIn, removeFrom } from "../../src/lib/vault-item-ops";
import { pinnedQueries, pinnedQueryLines, pinnedQueryBlock } from "@pablotech/akesi/pinned-queries";
import { findingInputsCanonicalString } from "../../src/lib/factors-hash";
import { SECTION_LABEL } from "../../src/lib/report-sections";
import type { Client } from "../../src/lib/types";

function client(over: Partial<Client> = {}): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male",
    watchlist: [], results: [], factors: {}, ...over,
  } as Client;
}

describe("@pablotech/akesi/item-registry", () => {
  it("mints a record on the first pin and deletes it again on unpin", () => {
    const id = itemRecordId("question", "Could this be early kidney disease?");
    const pinned = toggleItemPin(client(), id);
    expect(pinnedItems(pinned)).toEqual([{ kind: "question", label: "Could this be early kidney disease?", pinned: true }]);
    expect(isItemPinned(pinned, id)).toBe(true);

    const unpinned = toggleItemPin(pinned, id);
    expect(isItemPinned(unpinned, id)).toBe(false);
    // Absent, not [] — this is what keeps an untouched vault byte-identical and out of the hash.
    expect("itemRegistry" in unpinned).toBe(false);
  });

  // The whole reason the key is text rather than an id or an index: the next Finding rewrites these
  // lists, and a regeneration that only reflows the wording must not drop the star.
  it("keeps the pin when a regeneration reflows the same item's wording", () => {
    const pinned = toggleItemPin(client(), itemRecordId("glossary", "Apolipoprotein B"));
    expect(isPinnedItem(pinned, "glossary", "  apolipoprotein   b ")).toBe(true);
  });

  it("does NOT carry the pin to a genuinely different item, or to the same text in another section", () => {
    const pinned = toggleItemPin(client(), itemRecordId("glossary", "Apolipoprotein B"));
    expect(isPinnedItem(pinned, "glossary", "Apolipoprotein A1")).toBe(false);
    expect(isPinnedItem(pinned, "question", "Apolipoprotein B")).toBe(false);
  });

  it("keeps two questions sharing a 60-char prefix apart", () => {
    const long = "Given my family history and the last three panels, should we ";
    const a = toggleItemPin(client(), itemRecordId("question", long + "re-check ApoB?"));
    expect(isPinnedItem(a, "question", long + "re-check Lp(a)?")).toBe(false);
  });
});

describe("togglePinnedIn routes each kind to where its pin already lives", () => {
  it("a marker's pin IS watchlist membership", () => {
    const c = togglePinnedIn(client(), "marker", "ApoB");
    expect(c.watchlist).toEqual(["ApoB"]);
    expect(isPinnedIn(c, "marker", "ApoB")).toBe(true);
    expect(togglePinnedIn(c, "marker", "ApoB").watchlist).toEqual([]);
  });

  it("a ratio's pin is pinnedRatios, kept separate from the watchlist", () => {
    const c = togglePinnedIn(client(), "ratio", "TG/HDL");
    expect(c.pinnedRatios).toEqual(["TG/HDL"]);
    expect(c.watchlist).toEqual([]);
  });

  it("a report's pin is a boolean on its own SourceRecord", () => {
    const base = client({ sources: [{ id: "s1", sha256: "x", kind: "lab", file: "f", originalName: "o", importedAt: "2026-01-01" }] });
    const c = togglePinnedIn(base, "report", "s1");
    expect(c.sources![0].pinned).toBe(true);
    expect(isPinnedIn(c, "report", "s1")).toBe(true);
  });

  it("a generated item's pin is a lazily-minted registry record", () => {
    const id = itemRecordId("exploration", "Coronary calcium score");
    const c = togglePinnedIn(client(), "exploration", id);
    expect(isPinnedIn(c, "exploration", id)).toBe(true);
  });

  it("refuses to delete anything that has no deletable record", () => {
    const base = client({ sources: [{ id: "s1", sha256: "x", kind: "lab", file: "f", originalName: "o", importedAt: "2026-01-01" }], watchlist: ["ApoB"] });
    expect(removeFrom(base, "report", "s1")).toBe(base);
    expect(removeFrom(base, "marker", "ApoB")).toBe(base);
    expect(removeFrom(base, "question", itemRecordId("question", "q"))).toBe(base);
  });
});

describe("pinned queries", () => {
  const pinnedClient = () =>
    togglePinnedIn(
      togglePinnedIn(
        client({
          pinnedRatios: ["TG/HDL"],
          factors: { noteEntries: [{ id: "n1", text: "Dizzy after lunch", pinned: true }] },
        }),
        "question",
        itemRecordId("question", "Could this be early kidney disease?"),
      ),
      "ratio",
      "ApoB/ApoA1",
    );

  it("collects every pinned item across sections, but never the watchlist", () => {
    const c = { ...pinnedClient(), watchlist: ["ApoB"] };
    const sections = pinnedQueries(c).map((q) => q.section);
    expect(sections).toContain("Marker ratios");
    expect(sections).toContain("Questions");
    expect(sections).toContain("Notes");
    // Watchlisted markers already reach the prompt and the hash as their own key.
    expect(pinnedQueryLines(c).some((l) => l.includes("ApoB|") || l === "Markers|ApoB")).toBe(false);
  });

  // W62 P8 — this file used to spell two sections its own way ("Recommended markers", "Family
  // history") while the app said "Recommended Markers" and "Family". The label reaches the prompt
  // and the staleness hash, so it now comes from report-sections rather than a local table.
  it("names a section exactly as the app does", () => {
    const c = client({
      factors: { familyHistory: [{ id: "f1", relation: "Mother", condition: "T2D", pinned: true }] },
      itemRegistry: [{ kind: "recommendedMarkers", label: "Lp(a)", pinned: true }],
    } as Partial<Client>);
    const sections = pinnedQueries(c).map((q) => q.section);
    expect(sections).toContain(SECTION_LABEL["familyHistory"]);
    expect(sections).toContain(SECTION_LABEL["healthMarkers"]);
    expect(sections).not.toContain("Family history");
    expect(sections).not.toContain("Recommended markers");
  });

  it("says, in the prompt itself, that these are not evidence", () => {
    const block = pinnedQueryBlock(pinnedClient())!;
    expect(block).toMatch(/Areas of query/);
    expect(block).toMatch(/NOT evidence, NOT clinical record/);
    expect(block).toMatch(/never tell you what is true/);
    expect(block).toContain("Could this be early kidney disease?");
  });

  it("has no block at all when nothing is pinned", () => {
    expect(pinnedQueryBlock(client())).toBeNull();
  });
});

describe("staleness hash", () => {
  // The guard that matters: adding this key must not mark the entire existing user base stale.
  it("is byte-identical for a client with no pins, key omitted entirely", () => {
    const c = client({ watchlist: ["ApoB"], factors: { noteEntries: [{ id: "n1", text: "note" }] } });
    expect(findingInputsCanonicalString(c)).not.toContain("pinnedQueries");
  });

  it("changes once something is pinned", () => {
    const before = client({ factors: { noteEntries: [{ id: "n1", text: "note" }] } });
    const after = togglePinnedIn(before, "note", "n1");
    expect(findingInputsCanonicalString(after)).not.toBe(findingInputsCanonicalString(before));
    expect(findingInputsCanonicalString(after)).toContain("pinnedQueries");
  });

  it("a watchlisted marker alone still leaves the key absent", () => {
    const c = togglePinnedIn(client(), "marker", "ApoB");
    expect(findingInputsCanonicalString(c)).not.toContain("pinnedQueries");
  });
});
