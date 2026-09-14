import { describe, it, expect } from "vitest";
import { buildSearchIndex, chatSearchLeaves } from "../../src/lib/search-index";
import type { Client } from "../../src/lib/types";
import type { Thread } from "../../src/lib/chat-threads";

function client(): Client {
  return {
    results: [
      { marker: "Cortisol", group: "Hormones", source: "Quest Labs", value: 14, date: "2026-01-02", unit: "ug/dL" },
    ],
    watchlist: [],
    sources: [
      { id: "src1", sha256: "abc", kind: "lab", file: "f.xlsx", originalName: "Quest Labs 2026-01", importedAt: "2026-01-02T00:00:00Z" },
    ],
    factors: {
      diseases: [
        { id: "d1", date: "2026-01-02", diagnostic: "Mild aortic sclerosis", sourceId: "src1" },
        { id: "d2", date: "2026-01-02", diagnostic: "Trace mitral regurgitation", sourceId: "src1" },
      ],
      noteEntries: [{ id: "n1", text: "Ask about cortisol levels", pinned: false }],
      familyHistory: [{ id: "fh1", relation: "Mother", condition: "Type 2 diabetes" }],
      allergies: [{ id: "al1", allergen: "Penicillin", reaction: "Hives" }],
      treatments: [{ id: "t1", name: "Atorvastatin", kind: "drug", dose: "10mg", start: "2025-01" }],
    },
    finding: {
      definitions: [{ term: "HbA1c", definition: "Average blood glucose over ~3 months", group: "Cardiovascular" }],
      doctorConversation: [{ group: "Cardiovascular", questions: ["Should I repeat the lipid panel?"] }],
      treatmentGroups: [{ system: "Cardiovascular", topic: "Statins", patient: [], ai: ["Consider PCSK9 inhibitor", "Consider ezetimibe add-on"] }],
      decisions: {
        ai: [
          { intervention: "Consider PCSK9 inhibitor", purpose: "Lower LDL further" },
          { intervention: "Consider ezetimibe add-on", purpose: "Additional LDL lowering" },
        ],
      },
      dataRequisition: [{ type: "Lipid panel", group: "Cardiovascular", items: ["[new] Repeat ApoB"] }],
      progression: { latest: "LDL trending down since statin start", recent: "Stable weight", overall: "Improving cardiovascular risk profile" },
      planAssessment: "Current statin dose is appropriately titrated",
      disease: [{ group: "Cardiovascular", finding: "Mild atherosclerosis on imaging" }],
      patternAntipattern: { pattern: "Responds well to lipid-lowering therapy", antipattern: "Blood pressure remains inconsistent" },
      clinicalSynthesis: { adverse: "Family history of early CAD", favorable: "Consistent statin adherence", conditioning: "Biological age tracks below chronological" },
      finalThoughts: "Overall trajectory is favorable with continued monitoring",
    },
  } as unknown as Client;
}

describe("buildSearchIndex", () => {
  it("returns no leaves for a null client", () => {
    expect(buildSearchIndex(null, [])).toEqual([]);
  });

  it("wires healthReports and notes leaves in Phase 1", () => {
    const leaves = buildSearchIndex(client(), []);

    const report = leaves.find((l) => l.section === "healthReports");
    expect(report).toBeTruthy();
    expect(report!.anchor).toBeTruthy();
    expect(report!.searchText).toContain("Blood panel");

    const note = leaves.find((l) => l.section === "notes");
    expect(note).toBeTruthy();
    expect(note!.anchor).toBeTruthy();
    expect(note!.searchText).toContain("cortisol");

    const glossary = leaves.find((l) => l.section === "definitions");
    expect(glossary).toBeTruthy();
    expect(glossary!.anchor).toBeTruthy();
    expect(glossary!.searchText).toContain("HbA1c");

    const question = leaves.find((l) => l.section === "docInference");
    expect(question).toBeTruthy();
    expect(question!.anchor).toBeTruthy();
    expect(question!.searchText).toContain("lipid panel");

    for (const leaf of leaves) {
      expect(leaf.matchTab).toBeDefined();
    }
  });

  it("wires noteSearchLeaves so a query matches the AI's noteResults response, not just the jotted text (M92 Phase 8)", () => {
    const c = client();
    c.finding!.noteResults = [{ noteId: "n1", result: "Cortisol trends align with the current sleep pattern.", group: "Cardiovascular" }];
    const leaves = buildSearchIndex(c, []);
    const note = leaves.find((l) => l.section === "notes");
    expect(note).toBeTruthy();
    expect(note!.searchText).toContain("sleep pattern");
  });

  it("wires reportSearchLeaves at per-diagnosis granularity with a reportRef in Phase 4 (M103)", () => {
    const leaves = buildSearchIndex(client(), []);
    const reports = leaves.filter((l) => l.section === "healthReports");

    expect(reports.length).toBe(2);

    const sclerosis = reports.find((l) => l.searchText.includes("Mild aortic sclerosis"));
    expect(sclerosis).toBeTruthy();
    expect(sclerosis!.reportRef).toEqual({ sourceId: "src1", index: 0 });
    expect(sclerosis!.searchText).not.toContain("Trace mitral regurgitation");

    const regurgitation = reports.find((l) => l.searchText.includes("Trace mitral regurgitation"));
    expect(regurgitation).toBeTruthy();
    expect(regurgitation!.reportRef).toEqual({ sourceId: "src1", index: 1 });
    expect(regurgitation!.searchText).not.toContain("Mild aortic sclerosis");

    const anchors = new Set(reports.map((l) => l.anchor));
    expect(anchors.size).toBe(reports.length);

    for (const leaf of reports) {
      expect(leaf.searchText).toContain("Blood panel");
    }
  });

  it("falls back to a report-level leaf with no reportRef.index when a report has zero diagnoses", () => {
    const c = client();
    c.factors!.diseases = [];
    const leaves = buildSearchIndex(c, []);
    const reports = leaves.filter((l) => l.section === "healthReports");

    expect(reports.length).toBe(1);
    expect(reports[0].reportRef).toEqual({ sourceId: "src1" });
  });

  it("wires markerSearchLeaves with a markerRef in Phase 6", () => {
    const leaves = buildSearchIndex(client(), []);

    const marker = leaves.find((l) => l.section === "markers");
    expect(marker).toBeTruthy();
    expect(marker!.anchor).toBeTruthy();
    expect(marker!.searchText).toContain("Cortisol");
    expect(marker!.markerRef).toEqual({ name: "Cortisol", kind: "level" });
  });

  it("wires treatmentSearchLeaves in Phase 7", () => {
    const leaves = buildSearchIndex(client(), []);

    const treatment = leaves.find((l) => l.section === "treatment");
    expect(treatment).toBeTruthy();
    expect(treatment!.anchor).toBeTruthy();
    expect(treatment!.searchText).toContain("Atorvastatin");
  });

  it("wires hypothesisSearchLeaves at per-idea granularity with a hypothesisRef (M103)", () => {
    const leaves = buildSearchIndex(client(), []);
    const hypotheses = leaves.filter((l) => l.section === "futureTreatment");

    expect(hypotheses.length).toBe(2);

    const pcsk9 = hypotheses.find((l) => l.searchText.includes("PCSK9 inhibitor"));
    expect(pcsk9).toBeTruthy();
    expect(pcsk9!.hypothesisRef).toEqual({ topic: "Statins", side: "ai", index: 0 });
    expect(pcsk9!.searchText).not.toContain("ezetimibe");

    const ezetimibe = hypotheses.find((l) => l.searchText.includes("ezetimibe"));
    expect(ezetimibe).toBeTruthy();
    expect(ezetimibe!.hypothesisRef).toEqual({ topic: "Statins", side: "ai", index: 1 });
    expect(ezetimibe!.searchText).not.toContain("PCSK9");

    const anchors = new Set(hypotheses.map((l) => l.anchor));
    expect(anchors.size).toBe(hypotheses.length);
  });

  it("wires explorationSearchLeaves at per-item granularity, both items and dueSoon sides, in Phase 6 (M103)", () => {
    const c = client();
    c.finding!.dataRequisition = [
      { type: "Lipid panel", group: "Cardiovascular", items: ["[new] Repeat ApoB", "[Due soon] Recheck lipid panel"] },
    ];
    const leaves = buildSearchIndex(c, []);
    const exploration = leaves.filter((l) => l.section === "exploration");

    expect(exploration.length).toBe(2);

    const apob = exploration.find((l) => l.searchText.includes("Repeat ApoB"));
    expect(apob).toBeTruthy();
    expect(apob!.explorationRef).toEqual({ group: "Cardiovascular", type: "Lipid panel", side: "items", index: 0 });
    expect(apob!.searchText).not.toContain("Recheck lipid panel");

    const recheck = exploration.find((l) => l.searchText.includes("Recheck lipid panel"));
    expect(recheck).toBeTruthy();
    expect(recheck!.explorationRef).toEqual({ group: "Cardiovascular", type: "Lipid panel", side: "dueSoon", index: 0 });
    expect(recheck!.searchText).not.toContain("Repeat ApoB");

    const anchors = new Set(exploration.map((l) => l.anchor));
    expect(anchors.size).toBe(exploration.length);
  });

  it("wires analysisSearchLeaves at per-bubble granularity in Phase 8", () => {
    const leaves = buildSearchIndex(client(), []);
    const analysis = leaves.filter((l) => l.section === "analysis");

    const progression = analysis.find((l) => l.searchText.includes("LDL trending down"));
    expect(progression).toBeTruthy();
    expect(progression!.context).toBe("Health Progression");

    const onTreatment = analysis.find((l) => l.searchText.includes("appropriately titrated"));
    expect(onTreatment).toBeTruthy();
    expect(onTreatment!.context).toBe("On Treatment");

    const disease = analysis.find((l) => l.searchText.includes("Mild atherosclerosis"));
    expect(disease).toBeTruthy();
    expect(disease!.context).toBe("System Analysis");

    const pattern = analysis.find((l) => l.searchText.includes("Responds well to lipid-lowering"));
    expect(pattern).toBeTruthy();
    expect(pattern!.context).toBe("Pattern & Anti-pattern");

    const synthesis = analysis.find((l) => l.searchText.includes("Family history of early CAD"));
    expect(synthesis).toBeTruthy();
    expect(synthesis!.context).toBe("Health Synthesis");

    const finalThoughts = analysis.find((l) => l.searchText.includes("continued monitoring"));
    expect(finalThoughts).toBeTruthy();
    expect(finalThoughts!.context).toBe("Final Thoughts");

    const anchors = new Set(analysis.map((l) => l.anchor));
    expect(anchors.size).toBe(analysis.length);
    for (const leaf of analysis) {
      expect(leaf.matchTab).toBeDefined();
    }
  });
});

describe("chatSearchLeaves", () => {
  function thread(): Thread {
    return {
      id: "t1",
      title: "an unrelated first question",
      pinned: false,
      seq: 1,
      lastActivityAt: 0,
      turns: [
        { role: "user", text: "an unrelated first question" },
        { role: "assistant", text: "Ack 1" },
        { role: "user", text: "a later followup with the real match" },
        { role: "assistant", text: "Ack 2" },
      ],
    };
  }

  it("returns the last patient+ai pair, not the first", () => {
    const [leaf] = chatSearchLeaves([thread()]);

    expect(leaf.chatPair).toEqual({ patient: "a later followup with the real match", ai: "Ack 2" });
    expect(leaf.searchText).toContain("a later followup with the real match");
    expect(leaf.searchText).not.toContain("Ack 1");
  });

  it("emits no leaf for a thread with no user turn", () => {
    const t: Thread = { id: "t2", title: "empty", pinned: false, seq: 2, lastActivityAt: 0, turns: [] };
    expect(chatSearchLeaves([t])).toEqual([]);
  });
});

// W69 — a family-history entry is findable by its CONDITION, not only by the relation.
//
// familySidebarRows emitted the relation as the label and no searchText at all, so the index carried
// "Mother" and nothing else. Searching "diabetes" — the clinically meaningful half, and the half a
// patient would actually type — returned nothing, while the same patient's NOTE mentioning diabetes
// was found immediately, because noteSidebarRows has always passed `searchText`. The asymmetry was
// invisible because e2e's own family search test types the relation.
describe("family history is searchable by condition", () => {
  const index = buildSearchIndex(client(), []);
  const family = index.filter((l) => l.section === "familyHistory");

  it("indexes the entry at all", () => {
    expect(family).toHaveLength(1);
    expect(family[0].label).toBe("Mother");
  });

  it("finds it by the condition, which is the part worth searching for", () => {
    expect(family[0].searchText).toContain("Type 2 diabetes");
  });

  it("still finds it by the relation", () => {
    expect(family[0].searchText).toContain("Mother");
  });
});

// W69 — and the same gap in the sibling function, for the same reason.
//
// allergySidebarRows emitted the allergen as the label and no searchText, so the index carried
// "Penicillin" and not "Hives". A patient who remembers the REACTION but not the drug — which is the
// common way round — found nothing. Identical shape to the family-history gap, one function above it
// in the same file; fixing one and not the other would have left the asymmetry exactly as confusing.
describe("allergies are searchable by reaction", () => {
  const index = buildSearchIndex(client(), []);
  const allergies = index.filter((l) => l.section === "allergies");

  it("indexes the entry at all", () => {
    expect(allergies).toHaveLength(1);
    expect(allergies[0].label).toBe("Penicillin");
  });

  it("finds it by the reaction", () => {
    expect(allergies[0].searchText).toContain("Hives");
  });

  it("still finds it by the allergen", () => {
    expect(allergies[0].searchText).toContain("Penicillin");
  });
});
