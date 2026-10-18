import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isStamped, validate, sliceParity } from "@pablotech/neuro";
import { FINDING_DAG, findingDag, upstreamOf, downstreamOf, dagNode } from "../../src/lib/finding-dag";
import { nodeInputCanonical, INPUT_SLICES } from "../../src/lib/node-input-hash";
import { renderMermaid, extractDagBlock, docPath } from "../../scripts/gen-dag-mermaid";
import type { Client } from "../../src/lib/types";

describe("finding-dag manifest", () => {
  it("every input edge references a known node", () => {
    const keys = new Set(FINDING_DAG.map((n) => n.key));
    for (const n of FINDING_DAG) {
      for (const dep of n.inputs) expect(keys, `${n.key} → ${dep}`).toContain(dep);
    }
  });

  it("has no duplicate keys", () => {
    const keys = FINDING_DAG.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is acyclic (a node never transitively depends on itself)", () => {
    for (const n of FINDING_DAG) expect(upstreamOf(n.key).has(n.key), n.key).toBe(false);
  });

  it("source nodes have no upstream; leaves are downstream of the sources they cite", () => {
    for (const n of FINDING_DAG) {
      if (n.kind === "source") expect(n.inputs).toEqual([]);
    }
    // Editing a patient hypothesis reaches treatmentGroups + hypothesisEvaluation, not markerLevels.
    const d = downstreamOf("patientHypothesis");
    expect(d).toContain("treatmentGroups");
    expect(d).toContain("hypothesisEvaluation");
    expect(d).not.toContain("markerLevels");
    expect(d).not.toContain("healthProgression");
  });

  it("upstream/downstream are inverse across an edge", () => {
    expect(upstreamOf("treatmentGroups")).toContain("aiFindings");
    expect(downstreamOf("aiFindings")).toContain("treatmentGroups");
  });

  it("aiFindings is the taxonomy hub — every System-Analysis-ordered artifact is downstream of it (W25/W26)", () => {
    const d = downstreamOf("aiFindings");
    for (const k of ["studyResults", "treatmentAssessment", "treatmentGroups", "markerGroups"]) {
      expect(d, k).toContain(k);
    }
  });

  it("markerGroups is a projection downstream of the taxonomy + the raw marker set", () => {
    expect(dagNode("markerGroups")?.kind).toBe("projection");
    const up = upstreamOf("markerGroups");
    for (const k of ["aiFindings", "labData", "watchlist"]) expect(up, k).toContain(k);
  });

  it("dagNode looks a node up by key", () => {
    expect(dagNode("aiFindings")?.kind).toBe("derived");
    expect(dagNode("nope")).toBeUndefined();
  });
});

describe("neuro-pil validate (W61)", () => {
  // Deliberately redundant with several assertions above (unknown-input, duplicate-key, cycle,
  // source-has-inputs): a cross-check that the extracted library agrees with hand-rolled assertions
  // written before it existed. If validate() disagrees with those, the library is wrong, not the DAG.
  it("the Finding DAG has no findings", () => {
    expect(validate(findingDag)).toEqual([]);
  });

  it("slice coverage matches the source set", () => {
    expect(sliceParity(findingDag, INPUT_SLICES)).toEqual([]);
  });
});

function baseClient(): Client {
  return {
    displayName: "Test",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["ApoB"],
    results: [{ marker: "ApoB", group: "Lipids", source: "lab", date: "2026-01-01", value: 80, unit: "mg/dL" }],
    factors: {
      decisions: [{ id: "k1", intervention: "TRT", purpose: "free T" }],
      treatments: [
        { id: "t1", name: "Ezetimibe", dose: "10 mg", kind: "drug", start: "2025-01" }, // ongoing
        { id: "t2", name: "Start statin", kind: "behavior", start: "2099-02" }, // planned (far future)
      ],
      diseases: [{ id: "d1", date: "2025", diagnostic: "CAC 100" }],
      goal: "lower ApoB",
    },
    study: { entries: [{ id: "study-1", focus: "Suspicion", detail: "CVD" }] },
  };
}

// Which nodes' input-closure hash changed between two client states. Mirrors production nodeHashesOf /
// staleNodes, which exclude `projection` nodes (self-hashed out-of-band, not in finding.nodeHashes).
function changedNodes(a: Client, b: Client): Set<string> {
  const out = new Set<string>();
  for (const n of FINDING_DAG) {
    if (!isStamped(n)) continue;
    if (nodeInputCanonical(a, n.key) !== nodeInputCanonical(b, n.key)) out.add(n.key);
  }
  return out;
}

describe("per-node input hashing (W15b)", () => {
  it("is deterministic for the same client", () => {
    for (const n of FINDING_DAG) {
      expect(nodeInputCanonical(baseClient(), n.key)).toBe(nodeInputCanonical(baseClient(), n.key));
    }
  });

  it("a treatment edit invalidates every treatment-downstream node (W31 — treatments are one unified input)", () => {
    const b = baseClient();
    b.factors!.treatments = [
      { id: "t3", name: "Ezetimibe", dose: "20 mg", kind: "drug", start: "2025-01" }, // dose bump
      { id: "t4", name: "Start statin", kind: "behavior", start: "2099-02" },
    ];
    // treatmentHistory + patientPlan slices both derive from the unified list, so a treatment edit
    // reaches the treatment core (treatmentAssessment, clinicalSynthesis) AND the plan leaves.
    expect(changedNodes(baseClient(), b)).toEqual(
      new Set(["treatmentHistory", "patientPlan", "treatmentAssessment", "clinicalSynthesis", "treatmentGroups", "aiOnPlan", "finalThoughts"]),
    );
  });

  it("a patientHypothesis edit reaches the hypothesis/treatment/plan leaves, not the core", () => {
    const b = baseClient();
    b.factors!.decisions = [{ id: "k2", intervention: "TRT", purpose: "changed" }];
    expect(changedNodes(baseClient(), b)).toEqual(
      new Set(["patientHypothesis", "hypothesisEvaluation", "treatmentGroups", "doctorConversation", "aiOnPlan", "finalThoughts"]),
    );
  });

  // W71 — this used to assert `new Set(["watchlist", "healthMarkers"])`, i.e. that adding a marker to
  // your watchlist invalidated almost nothing. That was the bug written down as a test: the watchlist
  // is printed into buildUserMessage as the markers to track, so it steers every generated section,
  // and it was an input of no node. It now feeds markerLevels, which propagates to the whole core.
  it("a watchlist edit invalidates the synthetic core, because the watchlist steers every prompt", () => {
    const b = baseClient();
    b.watchlist = ["ApoB", "LDL"];
    const changed = changedNodes(baseClient(), b);
    for (const k of ["watchlist", "healthMarkers", "markerLevels", "aiFindings"]) expect(changed, k).toContain(k);
  });

  // The same hole, on the input every node's profile prose already carried. describeProfile prints
  // the diagnoses into the patientAssessment string that reaches every node; only three consumed it.
  it("a diagnosis edit invalidates the synthetic core, not just the disease-shaped nodes", () => {
    const b = baseClient();
    b.factors = { ...b.factors, diseases: [{ id: "d9", date: "2024-03", diagnostic: "Hashimoto" }] };
    const changed = changedNodes(baseClient(), b);
    for (const k of ["diagnosedDisease", "markerLevels", "aiFindings"]) expect(changed, k).toContain(k);
  });

  it("a lab-data edit invalidates the synthetic core (hubs propagate everywhere downstream)", () => {
    const b = baseClient();
    b.results = [{ marker: "ApoB", group: "Lipids", source: "lab", date: "2026-01-01", value: 90, unit: "mg/dL" }];
    const changed = changedNodes(baseClient(), b);
    for (const k of ["labData", "markerLevels", "aiFindings", "criticalRatios", "clinicalSynthesis"]) {
      expect(changed, k).toContain(k);
    }
  });
});

describe("generated DAG mermaid (W15b drift guard)", () => {
  it("the block checked into finding-dag.md equals the generator output", () => {
    const doc = readFileSync(docPath(), "utf8");
    expect(extractDagBlock(doc), "run `npm run dag:mermaid` to regenerate").toBe(renderMermaid());
  });
});
