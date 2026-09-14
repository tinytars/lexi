import { describe, it, expect } from "vitest";
import { mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { SYSTEM_PROMPT, buildUserMessage } from "@pablotech/akesi-pil/finding-generate";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import type { Client } from "../../src/lib/types";

// W65 — the guard for the gap the paid probe found. Cutting the four sections from SYSTEM_PROMPT was
// not enough: buildUserMessage still ordered the model to place every hypothesis and plan action
// "in exactly one `treatmentGroups` group", and the basis instructions still enumerated
// studyResults/noteResults/treatmentAssessment. The core duly emitted a malformed treatmentGroups
// and validate() rejected it — after a full Opus generation. This test costs nothing and fails in
// milliseconds on the same mistake.
//
// The rule: a section a leaf OWNS must not be named as an output anywhere the core is instructed.
// Naming one as INPUT is fine (the core reads finding.disease, treatments, etc.), which is why this
// matches the backtick-quoted output-key form the prompts use for a field they are asking for.
// `decisions` is NOT here: the core still owns decisions.ai, so the name legitimately appears. Its
// patient half is covered by the prompt telling the model to emit an empty array — asserted below.
const LEAF_OWNED_SECTIONS = ["treatmentGroups", "studyResults", "noteResults", "planAssessmentRows"] as const;

const client = () =>
  ({
    displayName: "Alex",
    results: [],
    watchlist: [],
    factors: {
      decisions: [{ id: "d1", intervention: "Try creatine", rationale: "r" }],
      treatments: [{ id: "t1", name: "Pregnenolone", start: "2099-01-15" }],
      noteEntries: [{ id: "n1", text: "a note" }],
    },
    study: { entries: [{ id: "s1", focus: "Sleep", detail: "d" }] },
    finding: { disease: [{ group: "Cardiovascular Risk", finding: "f" }] },
  }) as unknown as Client;

describe("the core prompt no longer asks for what a leaf owns", () => {
  it("every one of these sections really is leaf-owned", () => {
    const OWNER: Record<string, string> = { planAssessmentRows: "aiOnPlan" };
    for (const key of LEAF_OWNED_SECTIONS) expect(LEAF_REGEN_SPECS[OWNER[key] ?? key]).toBeDefined();
  });

  // The half-split section: the core keeps writing decisions.ai and must stop writing
  // decisions.patient, which hypothesisEvaluation owns.
  //
  // W68 — this used to assert `SYSTEM_PROMPT` contains "ALWAYS emit patient as an EMPTY": a literal
  // typed into the test and matched against the same literal in the prompt. It detected deletion of a
  // sentence and nothing else — and the validator actively ACCEPTS a populated decisions.patient, so a
  // green suite implied a guarantee that did not exist. What actually makes the core's copy harmless
  // is that the leaf supersedes it, and that is behaviour, so that is what this asserts now.
  it("whatever the core puts in decisions.patient, the leaf's merge supersedes it", () => {
    const withCoreJunk = {
      displayName: "P",
      watchlist: [],
      results: [],
      factors: { decisions: [{ intervention: "Pregnenolone", purpose: "sleep" }] },
      finding: {
        disease: [{ group: "Cardiovascular Risk", finding: "x" }],
        doctorConversation: [{ group: "Cardiovascular Risk", questions: ["q"] }],
        decisions: {
          ai: [],
          // The core disobeyed the prompt and wrote its own evaluation.
          patient: [{ intervention: "Pregnenolone", purpose: "sleep", pros: ["core"], cons: ["core"], alternatives: ["core"], recommendation: "CORE WROTE THIS" }],
        },
      },
    } as unknown as Client;

    const merged = mergeLeafResult(withCoreJunk, "hypothesisEvaluation", {
      patient: [{
        intervention: "Pregnenolone", purpose: "sleep",
        pros: ["p1", "p2"], cons: ["c1", "c2"], alternatives: ["a1", "a2"],
        recommendation: "LEAF WROTE THIS", questions: ["ask about it"],
      }],
    });

    expect(merged.finding!.decisions!.patient).toHaveLength(1);
    expect(merged.finding!.decisions!.patient[0].recommendation).toBe("LEAF WROTE THIS");
  });

  it("the system prompt does not name them as output keys", () => {
    for (const key of LEAF_OWNED_SECTIONS) {
      expect(SYSTEM_PROMPT, `SYSTEM_PROMPT still mentions ${key}`).not.toContain(key);
    }
  });

  // The half the first cut missed entirely: the per-patient user message, not the system prompt.
  it("the user message does not name them either", () => {
    const message = buildUserMessage(client());
    for (const key of LEAF_OWNED_SECTIONS) {
      expect(message, `buildUserMessage still mentions ${key}`).not.toContain(key);
    }
  });
});
