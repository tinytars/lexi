import type { Client, MarkerGrouping, Vault } from "../../src/lib/types";

// W69 — a fully synthetic patient, so e2e can stop sharing two real ones.
//
// `playwright.config.ts` pins `workers: 1` because most specs mutate Alex's and Blair's REAL vault rows
// through the real save API, and two workers doing that concurrently is a read-modify-write race. That
// single constraint is why 216 browser tests run strictly serially and why e2e is 87% of the gate's
// wall time. It also means every one of those specs needs plaintext PHI on the machine running it.
//
// The fix is not to mock the save path — that would stop testing the thing most worth testing. It is
// to give each Playwright WORKER its own patient, so concurrent writes land on different vaults. One
// per worker, not one per spec file: Playwright never runs two files concurrently within a worker, so
// four provisions buy exactly the isolation thirty-seven would.
//
// Content, not just shape. A patient with an empty vault satisfies `onboarding` and nothing else; the
// specs worth moving (sidebar grouping, search, nav) assert against real entities. So this carries one
// of every searchable kind — note, report + linked diagnosis, allergy, family history, study topic,
// glossary term, doctor question, analysis passage, treatment, hypothesis — plus a marker series long
// enough for MarkerChart to render.
//
// Everything is derived from `seed`, and the seed appears in the visible text of every entity. A
// mispaired assertion therefore names the worker that actually produced it, instead of failing with
// two indistinguishable patients.

const GROUPS = ["Cardiovascular Risk", "Metabolic Health"] as const;

/**
 * The visible marker stamped into every entity of a synthetic patient.
 *
 * Exported because it is the ONE definition: the e2e helper needs the same string to assert on, and
 * re-deriving it there is exactly the bug that cost a CI round-trip — the helper computed `W0` while
 * the fixture, seeded with the full slug `e2e-w0`, rendered `E2E-W0`.
 */
export const syntheticTag = (seed: string): string => seed.toUpperCase();

const DAY_MS = 86_400_000;

// Days-ago for each of a marker's 5 readings, keyed by body system. Anchored to `Date.now()` rather
// than fixed calendar dates — a fixed date eventually ages out of every time-window filter as CI runs
// on later dates. The two systems' NEWEST reading is deliberately staggered (60 days vs. 200): a
// "3 months" window then leaves Metabolic Health's markers with nothing to plot while Cardiovascular
// Risk's still show data, which is the partial-emptiness view-controls.spec.ts's W65 test needs.
const READING_AGES_DAYS: Record<(typeof GROUPS)[number], number[]> = {
  "Cardiovascular Risk": [825, 625, 400, 200, 60],
  "Metabolic Health": [825, 625, 400, 200, 200],
};

/** Dated marker readings — three per marker minimum, which is what a chart needs to draw a line. */
function results(seed: string): Client["results"] {
  const series: [marker: string, group: (typeof GROUPS)[number], unit: string, base: number][] = [
    ["ApoB", "Cardiovascular Risk", "mg/dL", 92],
    ["LDL Cholesterol", "Cardiovascular Risk", "mg/dL", 118],
    ["HDL Cholesterol", "Cardiovascular Risk", "mg/dL", 54],
    ["Triglycerides", "Cardiovascular Risk", "mg/dL", 104],
    ["Hemoglobin A1c", "Metabolic Health", "%", 5.4],
    ["Fasting Insulin", "Metabolic Health", "uIU/mL", 6.1],
  ];
  // The seed shifts every value, so a chart leaked from another worker is visibly the wrong series
  // rather than an identical one. Marker NAMES stay standard — they are what specs select on.
  const offset = [...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % 7;
  const now = Date.now();
  const labResults = series.flatMap(([marker, group, unit, base], m) =>
    READING_AGES_DAYS[group].map((daysAgo, d) => ({
      marker,
      group,
      source: "lab",
      date: new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10),
      value: Math.round(base * (1 + (((m * 5 + d * 3 + offset) % 9) - 4) / 100) * 100) / 100,
      unit,
    })),
  );
  // A second source in Cardiovascular Risk, alongside the lab-sourced markers above — the group
  // view-controls.spec.ts's M102 test needs a mixed-source group to prove against: everything still
  // renders in one flat stack, with no Blood/Imaging sub-header splitting it by source.
  const imagingResults = [825, 400, 60].map((daysAgo) => ({
    marker: `Coronary Calcium Score`,
    group: "Cardiovascular Risk" as const,
    source: "imaging",
    date: new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10),
    value: 40 + offset,
    unit: "Agatston",
  }));
  return [...labResults, ...imagingResults];
}

// The sidebar's per-system rows (marker-sidebar-groups.ts) classify by `client.markerGroups`, the
// AI's marker->body-system assignment — NOT by each result's own `group` field, which only drives
// the no-Finding-yet fallback wall (marker-grid.ts's `groupsOnly`). Omitting this left every marker
// unclassified, so the sidebar showed one catch-all "Uncategorized" row instead of "Cardiovascular
// Risk"/"Metabolic Health" — derived from `results()` so the two can't drift apart.
function markerGroupsFor(seed: string): MarkerGrouping {
  const byGroup = new Map<string, string[]>();
  for (const r of results(seed)) {
    const names = byGroup.get(r.group) ?? [];
    if (!names.includes(r.marker)) names.push(r.marker);
    byGroup.set(r.group, names);
  }
  return {
    groups: GROUPS.map((group) => ({ group, markers: byGroup.get(group) ?? [] })),
    markerGroupsHash: `${seed}`.padEnd(12, "0"),
    generatedAt: "2026-06-01T00:00:00Z",
    generatedBy: { mode: "dev", model: "synthetic-fixture" },
  };
}

/** Worker `i` gets patient `e2e-w{i}` — see tests/e2e/_synthetic.ts. Shared with provisioning so the
 * roster size has one definition instead of two independent hardcoded 4s. */
export const SYNTHETIC_WORKER_COUNT = 4;

/** The dedicated seed for the one synthetic patient whose Finding reads as stale on every node. */
export const FRESH_SEED = "fresh";

export interface SyntheticClientOptions {
  /**
   * Stamp `finding.nodeHashes` as an object that matches nothing this content could ever hash to,
   * so every DAG node reads as drifted (see src/lib/staleness.ts's `staleNodes`) and a leaf regen is
   * never gated. The default (omitted) leaves `nodeHashes` unset, which is the OTHER real shape a
   * Finding takes — `staleNodes` short-circuits to empty in that case — so a leaf regen is always
   * gated. Most specs want that: it is what makes the synthetic default safe to drill into from the
   * provider roster without an unprompted background sweep firing real leaf-regen calls on load.
   */
  fresh?: boolean;
}

/**
 * A synthetic patient whose every visible string carries `seed`.
 *
 * `seed` is short and human-readable (e.g. "w0"), because it shows up in assertion failures.
 */
export function syntheticClient(seed: string, opts: SyntheticClientOptions = {}): Client {
  const tag = syntheticTag(seed);
  return {
    displayName: `Synthetic ${tag}`,
    dob: "1979-04-12",
    gender: "female",
    watchlist: ["ApoB", "Hemoglobin A1c"],
    results: results(seed),
    markerGroups: markerGroupsFor(seed),
    // One marker carries a personalized range, so specs that assert the safe-zone band actually
    // renders (chart-zones.spec.ts) have something real to find — resolveRange() in
    // @pablotech/akesi/ranges reads this map, and MarkerChart draws no band without an entry.
    personalizedRanges: {
      ApoB: {
        low: 60,
        high: 90,
        unit: "mg/dL",
        meaning: `What ApoB measures, for ${tag}.`,
        explanation: `Personalized ApoB range for ${tag}.`,
        generalLow: 50,
        generalHigh: 120,
        generatedAt: "2026-06-01T00:00:00Z",
        factorsHash: `${seed}`.padEnd(12, "0"),
      },
    },
    sources: [
      {
        id: `src${seed}0001`,
        sha256: `${seed}`.padEnd(64, "0"),
        kind: "imaging",
        file: `records/private/${seed}/raw/${seed}-echo.pdf`,
        originalName: `${tag} Echocardiogram Report.pdf`,
        importedAt: "2025-06-02T00:00:00Z",
        studyType: `Echocardiogram ${tag}`,
        studyDate: "2025-06-01",
        diseaseCount: 1,
      },
    ],
    factors: {
      diseases: [
        // sourceId is load-bearing, not decoration: search-index.ts:146 indexes a diagnosis only
        // through the report it came from, so an unlinked one is invisible to search.
        {
          id: `dx-${seed}-1`,
          sourceId: `src${seed}0001`,
          date: "2024-03",
          diagnostic: `Coronary calcification ${tag}`,
          summary: `CAC score noted for ${tag}`,
        },
      ],
      treatments: [
        { id: `tx-${seed}-1`, name: `Rosuvastatin ${tag}`, dose: "10 mg", kind: "drug", start: "2024-05" },
        { id: `tx-${seed}-2`, name: `Metformin ${tag}`, dose: "500 mg", kind: "drug", start: "2023-01", end: "2024-01" },
        { id: `tx-${seed}-3`, name: `Ezetimibe ${tag}`, dose: "10 mg", kind: "drug", start: "2099-03" },
      ],
      allergies: [{ id: `al-${seed}-1`, allergen: `Penicillin ${tag}`, reaction: "Hives", severity: "moderate", dateNoted: "2019-08-01" }],
      familyHistory: [{ id: `fh-${seed}-1`, relation: "Mother", condition: `Type 2 diabetes ${tag}` }],
      decisions: [{ id: `id-${seed}-1`, intervention: `Berberine ${tag}`, purpose: "glycemic control" }],
      noteEntries: [
        { id: `nt-${seed}-1`, text: `Ask the cardiologist about statin intolerance — ${tag}` },
        { id: `nt-${seed}-2`, text: `Sleep quality has improved since March — ${tag}` },
      ],
      goal: `lower ApoB — ${tag}`,
      focus: "cardiovascular",
      height: "5'6\"",
      bmi: 23.8,
      smoking: "never",
      athletic: "moderate",
    },
    study: {
      entries: [
        { id: `st-${seed}-1`, focus: `Statin intolerance ${tag}`, detail: "Recurrent myalgia on prior therapy" },
      ],
    },
    finding: {
      progression: {
        latest: `Latest progression note for ${tag}.`,
        recent: `Recent progression note for ${tag}.`,
        overall: `Overall progression note for ${tag}.`,
      },
      disease: GROUPS.map((group) => ({ group, finding: `Analysis passage for ${group} — ${tag}.` })),
      studyResults: [{ study: `Statin intolerance ${tag}`, result: `Study read for ${tag}.`, group: "Cardiovascular Risk" }],
      noteResults: [
        { noteId: `nt-${seed}-1`, result: `Note read one for ${tag}.`, group: "Cardiovascular Risk" },
        { noteId: `nt-${seed}-2`, result: `Note read two for ${tag}.`, group: "Metabolic Health" },
      ],
      allergyResults: [{ allergyId: `al-${seed}-1`, result: `Allergy read for ${tag}.`, group: "Cardiovascular Risk" }],
      familyResults: [{ familyId: `fh-${seed}-1`, result: `Family history read for ${tag}.`, group: "Metabolic Health" }],
      diseaseResults: [{ diseaseId: `dx-${seed}-1`, result: `Diagnosis read for ${tag}.`, group: "Cardiovascular Risk" }],
      treatment: [
        { item: `Rosuvastatin ${tag}`, assessment: `Ongoing assessment for ${tag}.`, group: "Cardiovascular Risk", phase: "ongoing" },
        { item: `Metformin ${tag}`, assessment: `Past assessment for ${tag}.`, group: "Metabolic Health", phase: "past" },
      ],
      planAssessment: `Overall plan assessment for ${tag}.`,
      planAssessmentRows: [{ action: `Ezetimibe ${tag}`, assessment: `Planned assessment for ${tag}.` }],
      decisions: {
        patient: [
          {
            intervention: `Berberine ${tag}`,
            purpose: "glycemic control",
            pros: [`Pro one ${tag}`, `Pro two ${tag}`],
            cons: [`Con one ${tag}`, `Con two ${tag}`],
            alternatives: [`Alternative one ${tag}`, `Alternative two ${tag}`],
            recommendation: `Patient hypothesis recommendation for ${tag}.`,
          },
        ],
        ai: [
          {
            intervention: `Bempedoic acid ${tag}`,
            purpose: "LDL lowering",
            pros: [`AI pro one ${tag}`, `AI pro two ${tag}`],
            cons: [`AI con one ${tag}`, `AI con two ${tag}`],
            alternatives: [`AI alternative one ${tag}`, `AI alternative two ${tag}`],
            recommendation: `AI intervention recommendation for ${tag}.`,
          },
          // Second AI idea on the same topic — search-records.spec.ts's hypothesis test needs a
          // sibling idea to prove a search hit scopes the preview to just the matched one.
          {
            intervention: `Rosuvastatin ${tag}`,
            purpose: "LDL lowering",
            pros: [`AI pro three ${tag}`, `AI pro four ${tag}`],
            cons: [`AI con three ${tag}`, `AI con four ${tag}`],
            alternatives: [`AI alternative three ${tag}`, `AI alternative four ${tag}`],
            recommendation: `Second AI intervention recommendation for ${tag}.`,
          },
        ],
      },
      doctorConversation: [
        ...GROUPS.map((group) => ({ group, questions: [`Doctor question about ${group} for ${tag}?`] })),
        { group: `Berberine ${tag}`, questions: [`Doctor question about berberine for ${tag}?`] },
        // The AI tail must match decisions.ai's order exactly (finding-invariants.ts's band-structure
        // check) — Bempedoic acid then Rosuvastatin.
        { group: `Bempedoic acid ${tag}`, questions: [`Doctor question about bempedoic acid for ${tag}?`] },
        { group: `Rosuvastatin ${tag}`, questions: [`Doctor question about rosuvastatin for ${tag}?`] },
      ],
      definitions: [
        { term: `Apolipoprotein B ${tag}`, definition: `Glossary definition for ${tag}.`, group: "Cardiovascular Risk" },
        { term: `Insulin resistance ${tag}`, definition: `Second glossary definition for ${tag}.`, group: "Metabolic Health" },
      ],
      healthMarkers: {
        recommended: GROUPS.map((group) => ({
          group,
          markers: [{ name: `Lp(a) ${tag}`, rationale: `Recommended marker rationale for ${group} — ${tag}.` }],
        })),
      },
      dataRequisition: [
        { type: "Blood", group: "Cardiovascular Risk", items: [`Lipoprotein(a) ${tag}`] },
        // Three items, one of which mentions an echocardiogram — search-records.spec.ts's
        // multi-item exploration-cell test needs a modality group with siblings so it can assert
        // the search preview scopes to just the matched item, not the whole cell.
        {
          type: "Scan / Imaging",
          group: "Cardiovascular Risk",
          items: [`Coronary calcium score ${tag}`, `Repeat echocardiogram ${tag}`, `Aortic imaging ${tag}`],
        },
      ],
      // Without this, resolveTreatmentGroups returns null, buildHypothesisGroups returns null, and the
      // Future Treatment section — both the patient's ideas and the AI's — vanishes from the search
      // index entirely. A real Finding always carries it (W21).
      treatmentGroups: [
        { system: "Cardiovascular Risk", topic: `Lipid lowering ${tag}`, patient: [], ai: [`Bempedoic acid ${tag}`, `Rosuvastatin ${tag}`] },
        { system: "Metabolic Health", topic: `Glycemic control ${tag}`, patient: [`Berberine ${tag}`], ai: [] },
      ],
      patternAntipattern: { pattern: `Pattern passage for ${tag}.`, antipattern: `Anti-pattern passage for ${tag}.` },
      clinicalSynthesis: { adverse: `Adverse synthesis for ${tag}.`, favorable: `Favorable synthesis for ${tag}.` },
      finalThoughts: `Final thoughts for ${tag}.`,
      criticalRatios: [
        {
          name: `Triglycerides : HDL ${tag}`,
          numerator: "Triglycerides",
          denominator: "HDL Cholesterol",
          unit: "",
          meaning: `Ratio meaning for ${tag}.`,
          generalExplanation: `General explanation for ${tag}.`,
          explanation: `Personalized explanation for ${tag}.`,
        },
      ],
      generatedAt: "2026-06-01T00:00:00Z",
      inputsHash: `${seed}`.padEnd(12, "0"),
      // A present-but-empty map matches no real per-node hash (src/lib/staleness.ts's `nodeHashes()`
      // always produces a 12-hex-char string), so every DAG node reads as drifted from it — the
      // opposite of leaving this field unset, which staleNodes() short-circuits to "nothing stale".
      ...(opts.fresh ? { nodeHashes: {} } : {}),
    },
  };
}

/** The vault blob shape the app stores: one client, keyed by its slug. */
export function syntheticVault(seed: string, opts: SyntheticClientOptions = {}): Vault {
  return { clients: { [seed]: syntheticClient(seed, opts) } };
}

/** Worker `i` gets patient `e2e-w{i}` — see tests/e2e/_synthetic.ts. */
export const workerSeed = (index: number): string => `w${index}`;
