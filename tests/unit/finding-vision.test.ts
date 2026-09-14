import { describe, it, expect } from "vitest";
import { visionAttachmentsFor, VISION_ENABLED_NODES, documentAttachmentsFor, DOCUMENT_ENABLED_NODES } from "../../src/lib/finding-vision";
import type { Attachment } from "../../src/lib/types";

const img = (key: string): Attachment => ({ key, name: key, mediaType: "image/jpeg", bytes: 10, addedAt: "" });
const pdf = (key: string): Attachment => ({ key, name: key, mediaType: "application/pdf", bytes: 10, addedAt: "" });

describe("VISION_ENABLED_NODES", () => {
  it("is exactly the two Finding-input surfaces (Reports + Treatment) — never Notes or Chat", () => {
    expect(VISION_ENABLED_NODES.sort()).toEqual(["diseaseResults", "treatmentAssessment"]);
  });
});

describe("visionAttachmentsFor", () => {
  it("collects image attachments from treatmentHistory for treatmentAssessment", () => {
    const context = { treatmentHistory: [{ name: "Statin", start: "2024-01", attachments: [img("a"), pdf("b")] }] };
    expect(visionAttachmentsFor("treatmentAssessment", context, 10).map((a) => a.key)).toEqual(["a"]);
  });

  it("collects image attachments from diagnosedDisease for diseaseResults", () => {
    const context = { diagnosedDisease: [{ date: "2024-01-01", diagnostic: "x", attachments: [img("c")] }] };
    expect(visionAttachmentsFor("diseaseResults", context, 10).map((a) => a.key)).toEqual(["c"]);
  });

  it("returns [] for any node outside the whitelist, even if it has an attachments-shaped input — e.g. noteResults/pursuedNotes", () => {
    const context = { pursuedNotes: [{ id: "n1", text: "x", attachments: [img("should-never-appear")] }] };
    expect(visionAttachmentsFor("noteResults", context, 10)).toEqual([]);
  });

  it("returns [] when the whitelisted input key is absent from context", () => {
    expect(visionAttachmentsFor("treatmentAssessment", {}, 10)).toEqual([]);
  });

  it("filters out non-image attachments (a report's linked PDF stays text-only)", () => {
    const context = { diagnosedDisease: [{ date: "2024-01-01", diagnostic: "x", attachments: [pdf("report.pdf")] }] };
    expect(visionAttachmentsFor("diseaseResults", context, 10)).toEqual([]);
  });

  it("caps at maxCount across all rows combined", () => {
    const context = {
      treatmentHistory: [
        { name: "A", start: "2024-01", attachments: [img("1"), img("2")] },
        { name: "B", start: "2024-01", attachments: [img("3"), img("4")] },
      ],
    };
    expect(visionAttachmentsFor("treatmentAssessment", context, 3).map((a) => a.key)).toEqual(["1", "2", "3"]);
  });

  it("treats a row with no attachments field as contributing none", () => {
    const context = { treatmentHistory: [{ name: "Statin", start: "2024-01" }] };
    expect(visionAttachmentsFor("treatmentAssessment", context, 10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Documents. A DIFFERENT boundary from vision above, and the asymmetry is the thing under test:
// every leaf that answers a patient turn may read that turn's documents; the monolith core may not.
describe("DOCUMENT_ENABLED_NODES", () => {
  it("admits every leaf that answers a patient turn", () => {
    expect(DOCUMENT_ENABLED_NODES.sort()).toEqual([
      "aiOnPlan",
      "allergyResults",
      "diseaseResults",
      "familyResults",
      "hypothesisEvaluation",
      "noteResults",
      "studyResults",
      "treatmentAssessment",
    ]);
  });

  it("excludes every core Finding node — the Finding stays clean", () => {
    // These are finding-generate.ts's monolithic synthesis, not a patient turn. They must have no
    // entry, so documentAttachmentsFor returns [] even when handed a context that has attachments.
    for (const core of ["disease", "clinicalSynthesis", "patterns", "progression", "finalThoughts", "doctorConversation"]) {
      expect(DOCUMENT_ENABLED_NODES).not.toContain(core);
      const context = { pursuedNotes: [{ text: "n", attachments: [pdf("leak.pdf")] }] };
      expect(documentAttachmentsFor(core, context, 10)).toEqual([]);
    }
  });
});

describe("documentAttachmentsFor", () => {
  it("collects a note's attached PDF for noteResults — the case vision deliberately refuses", () => {
    const context = { pursuedNotes: [{ text: "n", attachments: [pdf("protocol.pdf"), img("photo.jpg")] }] };
    expect(documentAttachmentsFor("noteResults", context, 10).map((a) => a.key)).toEqual(["protocol.pdf"]);
  });

  it("reads studyResults out of pursuedStudy.entries, the one input key that isn't an array", () => {
    const context = { pursuedStudy: { entries: [{ id: "s1", focus: "f", detail: "d", attachments: [pdf("trial.pdf")] }] } };
    expect(documentAttachmentsFor("studyResults", context, 10).map((a) => a.key)).toEqual(["trial.pdf"]);
  });

  it("de-duplicates by key — a drug's document is mirrored across its dose rows", () => {
    const doc = pdf("coa.pdf");
    const context = {
      treatmentHistory: [
        { name: "Tirzepatide", start: "2025-01", attachments: [doc] },
        { name: "Tirzepatide", start: "2025-06", attachments: [doc] },
      ],
    };
    expect(documentAttachmentsFor("treatmentAssessment", context, 10)).toHaveLength(1);
  });

  it("accepts .txt and .md alongside PDF, and refuses a spreadsheet (that is a marker import)", () => {
    const file = (name: string, mediaType: string): Attachment => ({ key: name, name, mediaType, bytes: 1, addedAt: "" });
    const context = {
      patientAllergies: [{ allergen: "x", reaction: "y", attachments: [
        file("notes.txt", "text/plain"),
        file("protocol.md", "text/markdown"),
        file("labs.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ] }],
    };
    expect(documentAttachmentsFor("allergyResults", context, 10).map((a) => a.key)).toEqual(["notes.txt", "protocol.md"]);
  });

  it("caps at maxCount across all rows combined", () => {
    const context = { patientPlan: [{ name: "A", attachments: [pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf")] }] };
    expect(documentAttachmentsFor("aiOnPlan", context, 2).map((a) => a.key)).toEqual(["1.pdf", "2.pdf"]);
  });
});
