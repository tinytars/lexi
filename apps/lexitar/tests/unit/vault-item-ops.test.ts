import { describe, it, expect } from "vitest";
import { togglePinnedIn, renameIn, removeFrom, labelOf, renameFieldFor } from "../../src/lib/vault-item-ops";
import { capabilitiesFor, capabilitiesForRow } from "../../src/lib/sidebar-row-capabilities";
import type { Client } from "../../src/lib/types";

const client = (): Client =>
  ({
    displayName: "T", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
    factors: {
      noteEntries: [{ id: "n1", text: "felt tired" }, { id: "n2", text: "slept well", pinned: true }],
      allergies: [{ id: "a1", allergen: "Penicillin", reaction: "rash" }],
      familyHistory: [{ id: "f1", relation: "Father", condition: "CAD" }],
      decisions: [{ id: "d1", intervention: "Try ezetimibe", purpose: "LDL" }],
      treatments: [
        { id: "t1", name: "Tirzepatide", start: "2025-01-01" },
        { id: "t2", name: "Tirzepatide", start: "2025-06-01" },
        { id: "t3", name: "Aspirin", start: "2025-01-01" },
      ],
    },
    study: { entries: [{ id: "s1", focus: "Sleep", detail: "d" }] },
  }) as unknown as Client;

describe("togglePinnedIn", () => {
  it("pins and unpins by id without mutating the input", () => {
    const before = client();
    const after = togglePinnedIn(before, "note", "n1");
    expect(after.factors!.noteEntries![0].pinned).toBe(true);
    expect(before.factors!.noteEntries![0].pinned).toBeUndefined();
    expect(togglePinnedIn(after, "note", "n1").factors!.noteEntries![0].pinned).toBe(false);
  });

  it("leaves every other item untouched", () => {
    const after = togglePinnedIn(client(), "note", "n1");
    expect(after.factors!.noteEntries![1].pinned).toBe(true);
  });

  it("a medicine pin covers EVERY dose row of that drug, and only that drug", () => {
    const after = togglePinnedIn(client(), "medicine", "Tirzepatide");
    const rx = after.factors!.treatments!;
    expect(rx.filter((t) => t.name === "Tirzepatide").every((t) => t.pinned)).toBe(true);
    expect(rx.find((t) => t.name === "Aspirin")!.pinned).toBeUndefined();
  });

  it("unpins a medicine when any of its rows was pinned", () => {
    const pinned = togglePinnedIn(client(), "medicine", "Tirzepatide");
    const after = togglePinnedIn(pinned, "medicine", "Tirzepatide");
    expect(after.factors!.treatments!.every((t) => !t.pinned)).toBe(true);
  });

  it("works on study entries, which live outside factors", () => {
    expect(togglePinnedIn(client(), "study", "s1").study!.entries![0].pinned).toBe(true);
  });
});

describe("renameIn", () => {
  it("writes the kind's own label field", () => {
    expect(renameIn(client(), "study", "s1", "Sleep quality").study!.entries![0].focus).toBe("Sleep quality");
    expect(renameIn(client(), "allergy", "a1", "Amoxicillin").factors!.allergies![0].allergen).toBe("Amoxicillin");
    expect(renameIn(client(), "family", "f1", "Mother").factors!.familyHistory![0].relation).toBe("Mother");
    expect(renameIn(client(), "decision", "d1", "Try bempedoic acid").factors!.decisions![0].intervention).toBe("Try bempedoic acid");
  });

  it("trims, and refuses to blank a label", () => {
    expect(renameIn(client(), "study", "s1", "  Sleep  ").study!.entries![0].focus).toBe("Sleep");
    expect(renameIn(client(), "study", "s1", "   ").study!.entries![0].focus).toBe("Sleep");
  });

  it("is a no-op for a kind with no writable label — a note is free text, a drug name is a join key", () => {
    expect(renameFieldFor("note")).toBeUndefined();
    expect(renameFieldFor("treatment")).toBeUndefined();
    expect(renameFieldFor("medicine")).toBeUndefined();
    const after = renameIn(client(), "note", "n1", "new title");
    expect(after.factors!.noteEntries![0].text).toBe("felt tired");
  });
});

describe("removeFrom", () => {
  it("removes exactly one item", () => {
    const after = removeFrom(client(), "note", "n1");
    expect(after.factors!.noteEntries!.map((n) => n.id)).toEqual(["n2"]);
  });

  it("refuses to delete a medicine — that row stands for a whole dose history", () => {
    const after = removeFrom(client(), "medicine", "Tirzepatide");
    expect(after.factors!.treatments).toHaveLength(3);
  });
});

describe("labelOf", () => {
  it("returns the renameable label, or empty where there is none", () => {
    expect(labelOf(client(), "study", "s1")).toBe("Sleep");
    expect(labelOf(client(), "note", "n1")).toBe("");
  });
});

describe("sidebar row capabilities", () => {
  it("gives Notes pin+delete but no rename (free text, no title field)", () => {
    expect(capabilitiesFor("notes")).toEqual({ kind: "note", pin: true, rename: false, delete: true });
  });

  it("gives Study/Allergies/Family/Hypothesis the full set", () => {
    for (const s of ["study", "allergies", "family", "hypothesis"]) {
      expect(capabilitiesFor(s)).toMatchObject({ pin: true, rename: true, delete: true });
    }
  });

  it("splits Treatment: the All row is medicines, every other row is one dose period", () => {
    expect(capabilitiesForRow("treatment", "medicine")).toMatchObject({ kind: "medicine", delete: false });
    expect(capabilitiesForRow("treatment", "ongoing")).toMatchObject({ kind: "treatment", delete: true });
  });

  // W62 — these five had no per-item record and so got no menu at all. They have records now, and
  // every one of them pins WITHOUT rename or delete: a generated item's text is the Finding's own
  // words (renaming it would be overwritten by the next regeneration) and deleting one either
  // deletes a line the next regeneration writes back, or — for a report — expunges a file and every
  // reading derived from it.
  it("gives the five formerly record-less sections pin, and only pin", () => {
    for (const s of ["markers", "healthReports", "questions", "glossary", "exploration", "analysis"]) {
      expect(capabilitiesFor(s)).toMatchObject({ pin: true, rename: false, delete: false });
    }
  });

  it("splits Markers: a Ratios row is a ratio, every other row is a marker", () => {
    expect(capabilitiesForRow("markers", "ratios")).toMatchObject({ kind: "ratio" });
    expect(capabilitiesForRow("markers", "level:Cardiovascular Risk")).toMatchObject({ kind: "marker" });
    expect(capabilitiesForRow("markers", "ungrouped")).toMatchObject({ kind: "marker" });
  });

  // Notes hosts Questions/Markers/Glossary as sibling group rows, so a child's kind depends on the
  // group it sits under. Resolving by section alone gave a question the "note" kind, which would
  // have pinned a note id that does not exist and silently done nothing.
  it("resolves the three sections Notes hosts by their group key, not by Notes", () => {
    expect(capabilitiesForRow("notes", "ungrouped")).toMatchObject({ kind: "note" });
    expect(capabilitiesForRow("notes", "docInference")).toMatchObject({ kind: "question" });
    expect(capabilitiesForRow("notes", "healthMarkers")).toMatchObject({ kind: "recommendedMarkers" });
    expect(capabilitiesForRow("notes", "definitions")).toMatchObject({ kind: "glossary" });
  });

  it("never offers rename where vault-item-ops has no field for it", () => {
    for (const s of ["notes", "treatment"]) {
      const caps = capabilitiesFor(s)!;
      // RowKind is SidebarItemKind | "thread"; a thread renames through commitChatRename, not
      // through vault-item-ops' field table, so it is not this assertion's subject.
      if (caps.rename && caps.kind !== "thread") expect(renameFieldFor(caps.kind)).toBeDefined();
    }
  });
});
