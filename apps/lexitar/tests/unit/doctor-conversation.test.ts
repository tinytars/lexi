// W76 — the arithmetic that decides which questions belong to which section, now that it is taken in
// one place rather than restated by two readers who both cited a file that no longer exists.
//
// The property is partition: every group belongs to exactly one section, in order, with nothing
// dropped and nothing counted twice. That is what a hand-written `slice(nDisease + nPatient)` gets
// wrong when one of the two counts moves, and it gets it wrong silently — the questions still render.

import { describe, it, expect } from "vitest";
import { dcSlices } from "../../src/lib/doctor-conversation";
import { questionGroups } from "../../src/lib/question-items";
import type { Client } from "../../src/lib/types";

const g = (name: string) => ({ group: name, questions: [`why ${name}?`] });

const client = (disease: string[], patient: number, dc: string[]): Client =>
  ({
    results: [],
    finding: {
      disease: disease.map((name) => ({ group: name, name })),
      decisions: { patient: Array.from({ length: patient }, () => ({ intervention: "x" })), ai: [] },
      doctorConversation: dc.map(g),
    },
  }) as unknown as Client;

describe("dcSlices", () => {
  it("partitions the array: disease groups first, then patient decisions, then the AI's own", () => {
    const c = client(["Cardio", "Metabolic"], 1, ["Cardio", "Metabolic", "Fasting", "Sleep", "Iron"]);
    const s = dcSlices(c);
    expect(s.inference.map((x) => x.group)).toEqual(["Cardio", "Metabolic"]);
    expect(s.patient.map((x) => x.group)).toEqual(["Fasting"]);
    expect(s.ai.map((x) => x.group)).toEqual(["Sleep", "Iron"]);
  });

  it("covers every group exactly once, for any split", () => {
    for (const [nDisease, nPatient, total] of [[0, 0, 3], [2, 0, 2], [1, 2, 3], [3, 1, 7], [2, 2, 0]]) {
      const names = Array.from({ length: total }, (_, i) => `q${i}`);
      const s = dcSlices(client(names.slice(0, nDisease), nPatient, names));
      expect([...s.inference, ...s.patient, ...s.ai].map((x) => x.group)).toEqual(names);
    }
  });

  it("is empty in every section before the Finding exists", () => {
    const s = dcSlices({ results: [] } as unknown as Client);
    expect([s.inference, s.patient, s.ai]).toEqual([[], [], []]);
  });

  it("does not over-read when the array is shorter than the counts claim", () => {
    // A Finding whose doctorConversation came back thinner than its disease list — the sections
    // downstream of it must come back empty, not wrap around into the wrong groups.
    const s = dcSlices(client(["A", "B", "C"], 2, ["A"]));
    expect(s.inference.map((x) => x.group)).toEqual(["A"]);
    expect(s.patient).toEqual([]);
    expect(s.ai).toEqual([]);
  });
});

describe("the Questions section reads the same slice", () => {
  it("renders the disease groups and never a patient-decision or AI one", () => {
    const c = client(["Cardio", "Metabolic"], 1, ["Cardio", "Metabolic", "Fasting", "Sleep"]);
    expect(questionGroups(c).map((x) => x.group)).toEqual(["Cardio", "Metabolic"]);
  });
});
