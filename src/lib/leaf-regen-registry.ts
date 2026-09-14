// W15d — the generic DAG-driven leaf-regen engine. finding-dag.ts already declares, per node, the
// `inputs: string[]` list of upstream keys it depends on (the same list the `basis` prose has always
// described) — that IS the "right context" for regenerating a leaf, so context assembly is driven
// generically from it instead of each node hand-picking what to include (the treatmentGroups/regroup
// pattern this generalizes). Isomorphic: no node:/SDK imports, same discipline as finding-regroup.ts —
// both functions/api/leaf-regen.ts (server) and the browser (leaf-regen-client.ts) import this module.
//
// LEAF_REGEN_SPECS is left EMPTY here on purpose: this file is pure infrastructure, registered one
// node at a time in sibling changes so each of those diffs stays reviewable on its own.

import type { Client, ClientFinding, FindingDecisionEntry, TreatmentItem } from "./types";
import { dagNode } from "./finding-dag";
import { BRAIN_VERSIONS } from "./brain-versions";
import { CURRENT_DOSE_RULE, CO_MENTION_RULE, BUCKET_DOSE_RULE, STANDARD_DOSING_RULE } from "@pablotech/akesi-pil/treatment-timing-rules";
import { treatmentsOf } from "@pablotech/akesi-pil/treatment-normalize";
import { bucketOf, todayISODate, treatmentLabel, type Bucket } from "@pablotech/akesi-pil/treatment-bucket";
import { describeProfile, markerLevelBlocks, populatedNoteEntries } from "@pablotech/akesi-pil/finding-generate";
import { dailyTotalsByName } from "./treatment-conclusion";
import {
  buildRegroupInputs,
  REGROUP_SYSTEM_PROMPT,
  TREATMENT_GROUPS_TOOL,
  validateRegroup,
  resolveRegroup,
  type RegroupInputs,
  type RegroupResponse,
} from "@pablotech/akesi-pil/finding-regroup";

// One entry per DAG input key any leaf-regen node will need. Each accessor reuses the exact source
// (or, for markerLevels/patientAssessment, the exact prompt-builder logic) the monolith already uses
// for that context — see finding-generate.ts's describeProfile / markerLevelBlocks.
export const contextAccessors: Record<string, (client: Client) => unknown> = {
  aiFindings: (client) => client.finding?.disease ?? [],
  markerLevels: (client) => markerLevelBlocks(client),
  patientHypothesis: (client) => client.factors?.decisions ?? [],
  patientPlan: (client) => treatmentsOf(client).filter((t) => bucketOf(t, todayISODate()) === "planned"),
  aiHypothesis: (client) => client.finding?.decisions?.ai ?? [],
  // W82 — each row keeps its full raw shape (isEmpty/id-lookup below depend on that), plus a
  // `dailyTotal` attached to every currently-ongoing row of a medicine whose administration +
  // ingredient data supports a real number — summed across every ongoing row of that name (an AM
  // row and a PM row both count), the same computed total chat-context.ts hands the LexiTar chat.
  treatmentHistory: (client) => {
    const today = todayISODate();
    const items = treatmentsOf(client);
    const dailyTotals = dailyTotalsByName(items, today);
    return items.map((t) => {
      const total = dailyTotals.get(t.name.trim().toLowerCase());
      return total ? { ...t, dailyTotal: total } : t;
    });
  },
  pursuedStudy: (client) => client.study ?? {},
  pursuedNotes: (client) => populatedNoteEntries(client),
  hypothesisEvaluation: (client) => client.finding?.decisions?.patient ?? [],
  patientAssessment: (client) => describeProfile(client),
  // M97 §C — allergyResults/familyResults leaf specs below.
  patientAllergies: (client) => client.factors?.allergies ?? [],
  patientFamilyHistory: (client) => client.factors?.familyHistory ?? [],
  // M102 — diseaseResults leaf spec below. diagnosedDisease has no accessor above it because the
  // monolithic finding-generate.ts call builds its own context separately.
  diagnosedDisease: (client) => client.factors?.diseases ?? [],
};

// Default context assembly for a leaf node: every DAG input key this engine knows how to fetch. A key
// with no registered accessor is skipped (logged, not thrown) — a future node may declare an input
// this engine doesn't model yet (e.g. finalThoughts depends on treatmentGroups), out of scope here.
export function buildLeafContext(node: string, client: Client): Record<string, unknown> {
  // `today` is ambient, not a DAG input — but without it the treatment prompts are unanswerable.
  // CURRENT_DOSE_RULE defines the current dose as "the row whose window CONTAINS Today", and the
  // DATE AWARENESS checklist keys off "the Today: line"; neither existed in the payload, so the
  // model had to guess which titration row was current and reliably guessed wrong. The monolith
  // path always emitted a Today: line, which is why this only ever failed on the leaf path.
  // Not part of nodeInputCanonical, so adding it churns no staleness hash.
  const context: Record<string, unknown> = { today: todayISODate() };
  for (const key of dagNode(node)?.inputs ?? []) {
    const accessor = contextAccessors[key];
    if (!accessor) {
      console.warn(`leaf-regen-registry: no context accessor for "${key}" (input of "${node}")`);
      continue;
    }
    context[key] = accessor(client);
  }
  return context;
}

/**
 * The ONE way to build a node's outgoing context. A node with its own buildContext (treatmentGroups
 * returns RegroupInputs, not DAG-input keys) MUST use it, and calling buildLeafContext generically
 * instead produced a context its own isEmpty could not read — surfacing as an unattributable
 * "Cannot read properties of undefined (reading 'length')" rather than anything a reader could act
 * on. Every caller — the browser, the CLI backfills, the refresh orchestrator — goes through here.
 */
/**
 * Every row's `group` must name a body system the Finding actually has. Called by EVERY leaf whose
 * tool schema declares a `group` — a rule enforced by leaf-group-coverage in
 * tests/unit/leaf-merge-invariants.test.ts, not by memory.
 *
 * A row tagged with a system that does not exist is not a validation nicety — the UI groups these
 * under System Analysis headings, so an unknown tag renders the row under no heading at all. Worse,
 * it does not even fail visibly: system-groups.ts:38-41 sweeps an unknown tag into a "Not yet
 * categorized" bucket, so the row shows up under a heading the clinician never chose.
 *
 * W67 — this used to be called by two of the six leaves that tag rows, though all six prompts demand
 * it. The four that were missed were the four near-identical id-keyed row specs: the copy is why the
 * check reached two nodes and not six. The enumeration test is the actual fix; these calls are the
 * symptom.
 */
function assertDiseaseGroups(client: Client, node: string, rows: { group?: string }[]): void {
  // No early-out on an empty set: treatmentAssessment threw in that case before this helper existed,
  // and finding-assemble.ts throws too. A leaf regen only ever runs against an existing Finding, so
  // an empty disease[] means the Finding is malformed — the loud failure is the correct one.
  const groups = new Set((client.finding?.disease ?? []).map((d) => d.group));
  for (const row of rows) {
    if (row.group && !groups.has(row.group)) {
      throw new Error(`${node}: group "${row.group}" is not one of the current disease groups`);
    }
  }
}

export function leafContextFor(node: string, client: Client, targetLabels?: string[]): Record<string, unknown> {
  const spec = LEAF_REGEN_SPECS[node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${node}"`);
  return spec.buildContext ? spec.buildContext(client, targetLabels) : buildLeafContext(node, client);
}

/**
 * THE single gate a leaf response passes before anything is merged: shape first, then the response
 * against the context it was generated from. Both callers route through here — the in-process
 * runLeafRegen and the browser's fetchLeafRegen — so a rule can never hold on one path and not the
 * other, which is the failure this module exists to prevent.
 */
export function validateLeafResult(
  node: string,
  raw: unknown,
  context: Record<string, unknown>,
  targetLabels?: string[],
): unknown {
  const spec = LEAF_REGEN_SPECS[node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${node}"`);
  const validated = spec.validate(raw);
  spec.checkAgainstInput?.(context, validated, targetLabels);
  return validated;
}

// The subject a labeled entry is ABOUT, with any dose/quantity suffix stripped: everything from the
// first digit onward. "Rosuvastatin 20 mg" and "Rosuvastatin 20mg/day" are the same subject;
// "Magnesium Glycinate 1.5g/day" and "Magnesium Citrate" are not (the whole name before the dose is
// kept, not just the first word). Used to recognise a re-answer whose label drifted.
export function labelSubject(label: string): string {
  return label.toLowerCase().replace(/\s*\d.*$/, "").trim() || label.trim().toLowerCase();
}

// M68 P1 — the patch-by-label merge shape studyResults/treatmentAssessment both need: a returned entry
// matching an existing one by keyOf patches that existing entry in place (via buildNew(item, existing)
// if provided, else the returned item replaces it outright); a returned entry with no match is appended
// (via buildNew(item) if provided, else used as-is); an existing entry with no returned counterpart is
// left untouched (same object, same array position).
//
// `subjectOf` closes the hole that made re-translation look like a no-op. These labels carry the dose
// ("Rosuvastatin 20 mg"), so a regen that re-reads the dose answers under a DIFFERENT label
// ("Rosuvastatin 20mg/day"); keyed only by label that is not a match, so the fresh answer was appended
// and the stale one kept — and every reader takes the first match, i.e. the stale one. Re-running the
// regen could therefore never correct a wrong assessment, only accumulate copies. With `subjectOf`, a
// returned entry SUPERSEDES any existing entry about the same subject, whatever the label drift.
// Only content-labelled nodes need it; the id-keyed ones (notes/allergies/family/disease) cannot drift.
export function mergeLabeledItems<TExisting, TReturned>(
  existing: TExisting[],
  returned: TReturned[],
  keyOf: (item: TExisting | TReturned) => string,
  buildNew?: (item: TReturned, existing?: TExisting) => TExisting,
  subjectOf?: (item: TExisting | TReturned) => string,
): TExisting[] {
  const byKey = new Map(returned.map((item) => [keyOf(item), item]));
  const existingKeys = new Set(existing.map((item) => keyOf(item)));
  const returnedSubjects = subjectOf ? new Set(returned.map(subjectOf)) : undefined;
  const merged: TExisting[] = [];
  for (const item of existing) {
    const match = byKey.get(keyOf(item));
    if (match !== undefined) {
      merged.push(buildNew ? buildNew(match, item) : (match as unknown as TExisting));
      continue;
    }
    // Superseded: this regen answered about the same subject under a different label. Drop it rather
    // than leave a second, staler entry that readers would find first.
    if (returnedSubjects?.has(subjectOf!(item))) continue;
    merged.push(item);
  }
  for (const item of returned) {
    if (!existingKeys.has(keyOf(item))) {
      merged.push(buildNew ? buildNew(item) : (item as unknown as TExisting));
    }
  }
  return merged;
}

// The body every decision entry must have, in ONE place. finding-assemble.ts:298-320 states it for the
// core path; hypothesisEvaluation restates it for the leaf that now owns decisions.patient. Numbers
// deliberately match that function — 2..8 bullets, non-empty prose — so the two paths cannot drift.
function assertDecisionBody(label: string, d: FindingDecisionEntry): void {
  for (const field of ["pros", "cons", "alternatives"] as const) {
    const bullets = d[field];
    if (!Array.isArray(bullets) || bullets.length < 2) throw new Error(`${label} ${field} must be an array of 2+ bullets`);
    if (bullets.length > 8) throw new Error(`${label} ${field} has more than 8 bullets`);
    for (const [j, b] of bullets.entries()) {
      if (typeof b !== "string" || b.trim().length === 0) throw new Error(`${label} ${field}[${j}] is empty`);
    }
  }
  if (typeof d.recommendation !== "string" || d.recommendation.trim().length === 0) {
    throw new Error(`${label} recommendation is empty`);
  }
  if (typeof d.purpose !== "string" || d.purpose.trim().length === 0) throw new Error(`${label} purpose is empty`);
}

// The instruction every leaf regen opens with, ahead of the node's own systemPromptExtra. It lives
// here rather than beside the Anthropic call because it is part of the BRAIN — the static text that
// defines what a leaf regen is — and brain-source.ts has to be able to hash it without importing the
// SDK, which cannot load in a browser.
export const BASE_SYSTEM_PROMPT =
  "You are regenerating a single leaf section of a patient's health Finding, from exactly the " +
  "upstream context supplied below — not the whole Finding. Emit the result ONLY through the " +
  "provided tool.";

export interface LeafRegenSpec<TResult = unknown> {
  node: string;
  toolSchema: object;
  systemPromptExtra: string;
  /**
   * W71 — the Finding sections this leaf's mergeInto WRITES, and therefore the sections a full
   * refresh must not silently blank when the leaf fails.
   *
   * `assembleFinding` cannot produce these: three of them (allergyResults/familyResults/
   * diseaseResults) do not exist on `FindingAIResponse` at all, and the rest come back `?? []`
   * because W65 stopped the core narrating them. `orchestrateRefresh` replaced `client.finding`
   * wholesale with that object and saved it BEFORE any leaf ran, so a leaf that then failed left its
   * section empty forever — see carryForwardLeafSections.
   *
   * `keyof ClientFinding`, so a renamed section fails `npm run check` rather than quietly ceasing to
   * be carried forward. OMITTED for hypothesisEvaluation on purpose: it owns `decisions.patient`
   * (nested, not a whole section) and rewrites `doctorConversation` from it, so carrying half of that
   * pair forward would produce a Finding whose conversation band contradicts its own decisions. The
   * nodeHashes half of the W71 fix covers it instead — a failed hypothesisEvaluation now reads
   * *stale*, which is a retry prompt rather than a silent hole.
   */
  ownedSections?: readonly (keyof ClientFinding)[];
  // Name of the toolSchema.input_schema property holding the row array, for nodes that support
  // targetLabels scoping. That property's own description says "one entry per populated/every
  // row" — a SCOPE OVERRIDE in the system prompt alone contradicts it rather than overriding it,
  // so functions/api/leaf-regen.ts patches this property's (and the tool's own) description to
  // match the scope instead. Omit for nodes with no scoping support (treatmentGroups, aiOnPlan).
  scopedArrayKey?: string;
  // Defaults to buildLeafContext(node, client) when omitted; override only when a node needs
  // something the generic per-key assembly can't express (e.g. id-ref tagging).
  //
  // targetIds — the four id-keyed row leaves (noteResults/allergyResults/familyResults/
  // diseaseResults, see filterRowsById): content isn't guaranteed unique (two family members can
  // share "Mother" and the same condition), so they can't use the scopedArrayKey/SCOPE OVERRIDE
  // mechanism the other row-addressable nodes use — asking the model to self-select one row by
  // content is the ambiguity to avoid. Instead buildContext filters the row-list context key down to
  // the target id(s) BEFORE the request is sent, so the model only ever sees those rows and the
  // context's id list IS the set checkAgainstInput expects back. Omit/empty targetIds → full
  // unscoped context (every populated row).
  buildContext?(client: Client, targetIds?: string[]): Record<string, unknown>;
  isEmpty?(context: Record<string, unknown>): boolean;
  validate(raw: unknown): TResult;
  // Checks the response against the INPUT the model was given — the count/identity rules every leaf
  // prompt states ("one entry per row") and none used to enforce, because `validate` cannot see the
  // input and `mergeInto`'s client is NOT the input: applyLeafRegen deliberately merges onto whatever
  // client is live at save time (the M55/M56 stale-draft fix), so a row added mid-flight would make a
  // merge-time comparison both false-fail and, worse, compare against a list the model never saw.
  //
  // The rule this splits on, and the one that decides the next case: a check against the INPUT goes
  // here; a check against the EXISTING FINDING goes in mergeInto.
  //
  // targetLabels — the SCOPE OVERRIDE this request was sent with, for the content-scoped nodes whose
  // context is NOT pre-filtered (they carry a `scopedArrayKey` instead). A coverage rule has to know
  // that a scoped request was only ever asked for a subset; the id-keyed nodes need nothing here
  // because buildContext already narrowed their context.
  checkAgainstInput?(context: Record<string, unknown>, result: TResult, targetLabels?: string[]): void;
  // targetIds — mirrors buildContext's: when the request was scoped to specific ids, the returned
  // (shorter) result array must be paired against those SAME ids, not the full populated list, or
  // position 0 of a scoped response would wrongly land on the first row of the full list.
  mergeInto(client: Client, result: TResult, targetIds?: string[]): Client;
}

export interface HypothesisEvaluationEntry extends FindingDecisionEntry {
  questions: string[];
}

/**
 * Rebuild doctorConversation's middle band — one group per decisions.patient entry, positioned after
 * the disease groups and before the AI-consideration groups, which is the order finding-assemble.ts's
 * validator and the UI both rely on. Groups for interventions the leaf did not answer this run keep
 * whatever questions they already had.
 */
function withPatientDecisionQuestions(
  finding: ClientFinding,
  mergedPatient: FindingDecisionEntry[],
  answered: HypothesisEvaluationEntry[],
): { group: string; questions: string[] }[] {
  const dc = finding.doctorConversation ?? [];
  const diseaseCount = (finding.disease ?? []).length;
  const head = dc.slice(0, diseaseCount);
  const tail = dc.slice(diseaseCount);
  const patientNames = new Set(mergedPatient.map((d) => d.intervention));
  // The old middle band is whatever trailing groups name a patient decision; the AI band follows it.
  const aiBand = tail.filter((g) => !patientNames.has(g.group));
  const priorByName = new Map(tail.map((g) => [g.group, g.questions]));
  const freshByName = new Map(answered.map((e) => [e.intervention, e.questions]));
  const middle = mergedPatient
    .map((d) => ({ group: d.intervention, questions: freshByName.get(d.intervention) ?? priorByName.get(d.intervention) ?? [] }))
    .filter((g) => g.questions.length > 0);
  return [...head, ...middle, ...aiBand];
}

const HYPOTHESIS_EVALUATION_TOOL = {
  name: "emit_hypothesis_evaluation",
  description: "Emit the AI's pros/cons/alternatives/recommendation evaluation of each patient hypothesis entry.",
  input_schema: {
    type: "object" as const,
    properties: {
      patient: {
        type: "array",
        description: "One entry per patientHypothesis intervention, same order, one-to-one.",
        items: {
          type: "object",
          properties: {
            intervention: { type: "string", description: "copied verbatim from the patientHypothesis entry" },
            purpose: { type: "string", description: "copied verbatim from the patientHypothesis entry" },
            pros: { type: "array", items: { type: "string" }, description: "3–6 short bullets, each ≤30 words" },
            cons: { type: "array", items: { type: "string" }, description: "3–6 short bullets, each ≤30 words" },
            alternatives: { type: "array", items: { type: "string" }, description: "2–5 short bullets, each ≤40 words" },
            recommendation: { type: "string", description: "3–6 sentences of plain prose" },
            questions: {
              type: "array",
              items: { type: "string" },
              description:
                "2–4 short bullets (5–25 words each) the patient should literally raise with their doctor about THIS intervention, drawn from the pros/cons/alternatives/recommendation above",
            },
          },
          required: ["intervention", "purpose", "pros", "cons", "alternatives", "recommendation", "questions"],
        },
      },
    },
    required: ["patient"],
  },
};

// The clinical-reasoning half (the pros/cons/alternatives/recommendation/questions content) is
// vault-authored — clinical-vault/finding-dag/hypothesisEvaluation.md's `## Reasoning` section,
// synced here via `npm run dag:pull`. Only the grounding/cardinality plumbing stays hand-authored.
const HYPOTHESIS_EVALUATION_SYSTEM_PROMPT =
  "You evaluate each intervention the patient is weighing (patientHypothesis) with pros, cons, " +
  "alternatives, and a recommendation, grounded in the AI Findings (aiFindings) and the AI's own " +
  "proposed intervention set (aiHypothesis) supplied below. Emit exactly one entry per patientHypothesis " +
  "item, same order, copying its intervention and purpose verbatim — do not invent or drop entries. " +
  `${dagNode("hypothesisEvaluation")?.reasoning} ` +
  "Emit the result ONLY through the emit_hypothesis_evaluation tool.";

const AI_ON_PLAN_TOOL = {
  name: "emit_plan_assessment_rows",
  description: "Emit the AI's assessment of each Patient Plan action.",
  input_schema: {
    type: "object" as const,
    properties: {
      rows: {
        type: "array",
        description: "One entry per patientPlan action, same order, one-to-one.",
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "copied verbatim from the patientPlan action's name — WITHOUT any timing prefix" },
            assessment: { type: "string", description: "1–2 sentences on THAT specific action" },
          },
          required: ["action", "assessment"],
        },
      },
    },
    required: ["rows"],
  },
};

// The clinical-reasoning half (the per-action assessment guidance — synergy/conflict framing) is
// vault-authored — clinical-vault/finding-dag/aiOnPlan.md's `## Reasoning` section, synced here via
// `npm run dag:pull`. The imported dosing-rule constants below stay hand-authored, in place.
const AI_ON_PLAN_SYSTEM_PROMPT =
  "You assess each action in the patient's Patient Plan (patientPlan) individually, grounded in the " +
  "patient's overall profile (patientAssessment), lab markers (markerLevels), AI Findings (aiFindings), " +
  "and the current hypothesis evaluation (hypothesisEvaluation) supplied below. Emit exactly one entry " +
  "per patientPlan action, same order, copying its action text verbatim (WITHOUT any timing prefix) — do " +
  "not invent or drop entries. " +
  `${dagNode("aiOnPlan")?.reasoning} ` +
  CO_MENTION_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "This action has NOT started yet, so another treatment is concurrent with it only if that treatment " +
  "is still active at THIS action's start date — one that ends before then is a predecessor, not a " +
  "companion, and must not be described as running alongside it. If patientPlan is " +
  "empty, return an empty rows array. Emit the result ONLY through the emit_plan_assessment_rows tool.";

/** One row of the treatmentAssessment leaf's answer. `treatmentId` echoes TreatmentItem.id (W71). */
interface TreatmentAssessmentItem {
  treatmentId: string;
  item: string;
  assessment: string;
  group: string;
  phase?: Bucket;
}

const TREATMENT_ASSESSMENT_TOOL = {
  name: "emit_treatment_assessment",
  description: "Emit the AI's assessment of each current treatment item (medication or supplement).",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "One entry per (medication/supplement, phase) — drugs before supplements. A drug with past, ongoing and planned rows gets three entries.",
        items: {
          type: "object",
          properties: {
            treatmentId: {
              type: "string",
              description: "the `id` of the treatment this entry is about, copied EXACTLY from the treatmentHistory entry you are assessing",
            },
            item: { type: "string", description: "the drug or supplement name with the dose for THIS phase, copied verbatim" },
            phase: {
              type: "string",
              enum: ["past", "ongoing", "planned"],
              description: "which slice of this drug's history the assessment is about — one entry per phase the drug actually has",
            },
            assessment: { type: "string", description: "2–4 sentences of plain prose about THAT phase only" },
            group: { type: "string", description: "the body system this treatment addresses — copied VERBATIM from one of the disease[].group names" },
          },
          required: ["item", "phase", "assessment", "group"],
        },
      },
    },
    required: ["items"],
  },
};

// Tier 2 (W15d follow-up) — treatmentAssessment reassesses ONLY finding.treatment[].assessment.
// Carries the SAME date-awareness and dose-titration-dedupe instructions the monolith prompt uses
// for this section (finding-generate.ts's DATE AWARENESS block and its treatment-section DEDUPE BY
// DRUG/SUPPLEMENT NAME rule) so a leaf-regenerated assessment doesn't regress relative to the
// monolith's output. The clinical-reasoning half (marker-effect attribution, PRODUCT DATA usage) is
// vault-authored — clinical-vault/finding-dag/treatmentAssessment.md's `## Reasoning` section, synced
// here via `npm run dag:pull`. The DATE AWARENESS block and dosing-rule constants stay hand-authored.
const TREATMENT_ASSESSMENT_SYSTEM_PROMPT =
  "You reassess the `assessment` prose for each current treatment item, grounded in the patient's " +
  "overall profile (patientAssessment), lab markers (markerLevels), the full current treatment list " +
  "(treatmentHistory), and the AI Findings disease decomposition (aiFindings) supplied below. Walk " +
  "every medication first, then every supplement — drugs before supplements, no mixing. Within each " +
  "block, order items by their relation to the disease findings above: the item tied to the " +
  "highest-severity / most acute finding comes first, the item tied to the weakest or absent finding " +
  "comes last. " +
  "ONE ENTRY PER (DRUG, PHASE). The treatment list carries the same drug on multiple rows when its " +
  "dose was titrated — each row is a dose change with its own dates, not a separate medication. " +
  "Group those rows by drug name (case-insensitive, ignoring dose), then split each drug's rows by " +
  "PHASE: rows whose window has ended are `past`, the row whose window contains Today is `ongoing`, " +
  "rows starting after Today are `planned`. Emit ONE entry per phase that drug actually has, and set " +
  "`phase` accordingly — so a drug that was titrated, is being taken now, and has a scheduled " +
  "increase yields THREE entries, each about its own phase only. Emit no entry for a phase the drug " +
  "does not have. Never emit two entries with the same drug name AND the same phase. " +
  "This is what lets a Past card be written purely in the past tense while the Ongoing card for the " +
  "same drug speaks about the present: they are different entries, not one text shown twice. " +
  "For each entry: item: the drug or supplement name with the dose that applies to THAT phase — the " +
  "current dose for `ongoing`, the final dose reached for `past`, the scheduled dose for `planned`. " +
  CURRENT_DOSE_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "(e.g. \"Ezetimibe 10 mg\", " +
  "\"Micronized Progesterone 15 mg\"). Use the exact spelling and casing of the drug name and the dose " +
  "string verbatim from that row; do not invent dose. Do not annotate the name with category — " +
  "drug-vs-supplement is conveyed by ordering. group: the body system this treatment addresses — " +
  "copied VERBATIM from one of the disease[].group names in aiFindings above (e.g. \"Cardiovascular " +
  "Risk\", \"Body Composition\", \"Hormonal / Endocrine\"). Every treatment group MUST be one of the " +
  "disease groups; assign each item to the system its therapy most directly targets. " +
  `${dagNode("treatmentAssessment")?.reasoning} ` +
  "A treatment row's `dailyTotal`, when present, is the already-computed daily ingredient amount " +
  "summed across every currently-ongoing row of that medicine (an AM row and a PM row both count) " +
  "— use it directly for any dose/ingredient-adequacy read and never re-derive one yourself by " +
  "multiplying an ingredient's label amount; when `dailyTotal` is absent, do not estimate one. " +
  CO_MENTION_RULE + " " +
  "If the patient has no current medications and no current supplements, emit a single entry " +
  "{ item: \"Current regimen\", assessment: \"...\", group: <the disease group the note most relates " +
  "to, or the first disease group if none fits better> } that notes the absence in one sentence and " +
  "suggests what to discuss with the physician given the disease findings above. " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins " +
  "with a `Today:` line carrying the current date, and every medication / supplement row in the " +
  "treatment list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active " +
  "dose for that row. • A closed range (e.g. [April–May 2026]) — this dose was active only " +
  "during that window. A row in this shape is a PRIOR dose level in a titration sequence; the row " +
  "with [Since Y] for the same drug is the current dose. A marker reading can only reflect a " +
  "treatment's effect if the reading was DRAWN DURING THE WINDOW the dose was active. For ongoing " +
  "rows that means the reading date must be after the \"Since X\" date; for closed ranges it means " +
  "the reading date must fall inside the range. Before you write any sentence of the form \"X has " +
  "produced effect Y\", or \"the dose increase is showing up as Z\", check explicitly: 1. Which row " +
  "of the titration is the CURRENT dose? " +
  CURRENT_DOSE_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "2. What is the date the current dose started " +
  "(the X in [Since X])? 3. What " +
  "is the date of the latest reading for the marker(s) you are about to credit to the treatment? " +
  "4. If the latest reading PRE-DATES the current dose's start, the reading CANNOT reflect that " +
  "current dose's effect — do not attribute. Say so plainly instead: \"the latest [marker] reading " +
  "[date] pre-dates the [drug] titration to [dose] [since-date], so the current dose has not been " +
  "re-tested yet; recheck in 8–12 weeks\". 5. If the latest reading is AFTER the current dose's start " +
  "but by an amount too short to expect an effect (e.g. < 2–4 weeks for most lab markers, < 8 weeks " +
  "for HbA1c, < 12 weeks for body composition), say so plainly — the dose is too new to assess yet. " +
  "6. When a reading falls within a closed-range row's window, you may attribute the effect at THAT " +
  "historical dose, not the current one. Do not make up effects that the timeline does not support. " +
  "Emit the result ONLY through the emit_treatment_assessment tool.";

const STUDY_RESULTS_TOOL = {
  name: "emit_study_results",
  description: "Emit the AI's answer for each populated Pursued Study row, tagged to a body system.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "One entry per populated Pursued Study row, in named-tuple order.",
        items: {
          type: "object",
          properties: {
            study: { type: "string", description: "the row label verbatim — the named study tuple's focus, copied exactly as the row is labelled in the Proposed Study block" },
            result: { type: "string", description: "4–7 sentences of plain prose" },
            group: { type: "string", description: "the body system this study line belongs to — copied VERBATIM from one of the disease[].group names" },
          },
          required: ["study", "result", "group"],
        },
      },
    },
    required: ["items"],
  },
};

// Tier 2 (W15d follow-up) — studyResults reassesses ONLY finding.studyResults[].result, leaving the
// study/group identity fields on covered entries and any uncovered entries untouched. Carries the SAME
// row-selection/order instruction and DATE AWARENESS block the monolith prompt uses for this section
// (finding-generate.ts's studyResults section and its DATE AWARENESS block) so a leaf-regenerated
// result doesn't regress relative to the monolith's output. The clinical-reasoning half (how to answer
// what a study concludes) is vault-authored — clinical-vault/finding-dag/studyResults.md's
// `## Reasoning` section, synced here via `npm run dag:pull`.
const STUDY_RESULTS_SYSTEM_PROMPT =
  "You answer each populated row of the patient's Pursued Study (pursuedStudy), grounded in the " +
  "patient's overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings " +
  "disease decomposition (aiFindings) supplied below. The Proposed Study block can carry any number " +
  "of named study tuples (e.g. Effect, Presence, Synergy, Selection). Emit ONE entry for EACH line " +
  "present, in the order they appear. If the Proposed Study block " +
  "is absent or empty, return an empty items array. " +
  "For each entry: study: the row label verbatim — the named tuple's " +
  "focus (e.g. \"Effect\", \"Presence\", \"Synergy\"). Copy it exactly as the row is labelled in the " +
  "Proposed Study block. " +
  `${dagNode("studyResults")?.reasoning} ` +
  "group: the body " +
  "system this study line belongs to — copied VERBATIM from one of the disease[].group names in " +
  "aiFindings above (e.g. \"Cardiovascular Risk\", \"Hormonal / Endocrine\"). Pick the system the study " +
  "most directly concerns. Every studyResults group MUST be one of the disease groups — the UI renders " +
  "the study lines under body-system headings in disease order. (Still emit the entries in study-row " +
  "order — the group tag, not array order, drives the headings.) " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins with " +
  "a `Today:` line carrying the current date, and every medication / supplement row in the treatment " +
  "list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active dose for " +
  "that row. • A closed range (e.g. [April–May 2026]) — this dose was active only during that window. " +
  "A row in this shape is a PRIOR dose level in a titration sequence; the row with [Since Y] for the " +
  "same drug is the current dose. A marker reading can only reflect a treatment's effect if the " +
  "reading was DRAWN DURING THE WINDOW the dose was active. For ongoing rows that means the reading " +
  "date must be after the \"Since X\" date; for closed ranges it means the reading date must fall " +
  "inside the range. Before you write any sentence of the form \"X has produced effect Y\", or \"the " +
  "dose increase is showing up as Z\", check explicitly: 1. Which row of the titration is the CURRENT " +
  "dose? It is the row whose window CONTAINS Today — start on or before Today, and either no end or an " +
  "end on or after Today. A [Since X] row whose X is in the FUTURE is a scheduled step, not the present, " +
  "and a closed range that spans Today IS the present; do not assume the newest row is the current one. " +
  "2. What is " +
  "the date the current dose started (the X in [Since X])? 3. What is the date of the latest reading " +
  "for the marker(s) you are about to credit to the treatment? 4. If the latest reading PRE-DATES the " +
  "current dose's start, the reading CANNOT reflect that current dose's effect — do not attribute. Say " +
  "so plainly instead: \"the latest [marker] reading [date] pre-dates the [drug] titration to [dose] " +
  "[since-date], so the current dose has not been re-tested yet; recheck in 8–12 weeks\". 5. If the " +
  "latest reading is AFTER the current dose's start but by an amount too short to expect an effect " +
  "(e.g. < 2–4 weeks for most lab markers, < 8 weeks for HbA1c, < 12 weeks for body composition), say " +
  "so plainly — the dose is too new to assess yet. 6. When a reading falls within a closed-range row's " +
  "window, you may attribute the effect at THAT historical dose, not the current one. Do not make up " +
  "effects that the timeline does not support. Emit the result ONLY through the emit_study_results tool.";

// ---------------------------------------------------------------------------
// The four id-keyed row leaves — noteResults, allergyResults, familyResults, diseaseResults. Each
// answers a list of rows the PATIENT entered (notes, allergies, family history, diagnoses) and stores
// one result per row keyed by that row's id. They were four copies of one shape, and the copy cost what
// a copy costs: assertDiseaseGroups was added to two OTHER leaves and never to these four, though all
// four prompts demand it. The shape is shared here; the four specs stay written out.
//
// W67 — these paired the model's answers to rows by ARRAY POSITION, and the comments here argued for
// it: an allergen name, or a "Mother"/"Type 2 diabetes" pair, is not unique, so a returned LABEL cannot
// identify a row. That reasoning is sound and is not what changed. What it missed is that an id is not
// a label — it is an opaque token already in the payload, so echoing it back is copying, not
// self-selection. Position pairing cannot notice a SKIPPED row: 5 answers for 6 notes filed every
// answer from the gap onward against the wrong note, silently, and the `.filter()` on a short id list
// only trimmed the overflow. Worse, applyLeafRegen deliberately merges onto whatever client is live at
// save time (the M55/M56 stale-draft fix), so position `i` could index a list the model never saw.
// Echoing the id removes the failure mode instead of trying to detect it.

interface IdRowResult {
  result: string;
  group: string;
  [idField: string]: string;
}

function idRowTool(name: string, rowNoun: string, contextKey: string, idField: string) {
  return {
    name,
    description: `Emit the AI's response to each ${rowNoun}, tagged to a body system.`,
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: `One entry per ${contextKey} entry. Each entry carries the id of the row it answers, so order does not matter.`,
          items: {
            type: "object",
            properties: {
              [idField]: { type: "string", description: `copied VERBATIM from the "id" field of the ${rowNoun} this entry answers` },
              result: { type: "string", description: "3–6 sentences of plain prose" },
              group: { type: "string", description: `the body system this ${rowNoun} most directly concerns — copied VERBATIM from one of the disease[].group names` },
            },
            required: [idField, "result", "group"],
          },
        },
      },
      required: ["items"],
    },
  };
}

function idEchoRule(contextKey: string, idField: string): string {
  return (
    `Emit ONE entry for EACH ${contextKey} entry present. On every entry set "${idField}" to that row's ` +
    `"id" value, copied VERBATIM — that is how your answer is matched back to its row. An entry whose ` +
    `${idField} is missing, invented, or repeated, or a row left unanswered, rejects the whole response. ` +
    `Order does not matter; the id does. If ${contextKey} is empty, return an empty items array. `
  );
}

function validateIdRows(idField: string) {
  return (raw: unknown): { items: IdRowResult[] } => {
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) throw new Error("items missing or not an array");
    for (const entry of items) {
      const e = entry as Record<string, unknown>;
      if (typeof e?.[idField] !== "string" || typeof e?.result !== "string" || typeof e?.group !== "string") {
        throw new Error(`item does not match { ${idField}, result, group } shape`);
      }
      // W75 — a present-but-empty string is not an answer. `typeof === "string"` alone let
      // `result: ""` through, and the row then rendered a blank AI paragraph under its heading, which
      // reads as "nothing to say" rather than "the model returned nothing". assertDecisionBody has
      // always made this distinction for decision entries; the row leaves never did.
      if ((e[idField] as string).trim() === "" || (e.result as string).trim() === "" || (e.group as string).trim() === "") {
        throw new Error(`item has an empty ${idField}, result or group`);
      }
    }
    return { items: items as IdRowResult[] };
  };
}

// Row-scoped regen (one row's Translate menu item) narrows the row list BEFORE the request is sent, so
// the context's id list is always exactly the set the model was asked about — scoped and unscoped share
// one path, and assertIdSetMatches needs no separate scoped branch.
function filterRowsById(node: string, contextKey: string) {
  return (client: Client, targetIds?: string[]): Record<string, unknown> => {
    const context = buildLeafContext(node, client);
    if (!targetIds?.length) return context;
    const ids = new Set(targetIds);
    return { ...context, [contextKey]: (context[contextKey] as { id: string }[]).filter((r) => ids.has(r.id)) };
  };
}

// Checked against the INPUT the model actually saw, never against the client — see the checkAgainstInput
// note on LeafRegenSpec for why those are not the same list.
/**
 * The label-keyed twin of assertIdSetMatches — membership, duplicates AND coverage.
 *
 * W75. `aiOnPlan` made all three checks; `hypothesisEvaluation` made only membership and
 * `studyResults` made none at all, so a fabricated `study` label merged in as a brand-new row and a
 * row the model silently skipped stayed unanswered with nothing to say so. Matching is by
 * `labelSubject` for the reason aiOnPlan's comment gives: the model answers with the subject, not the
 * annotated label the row happens to carry.
 *
 * A SCOPE OVERRIDE request (`targetLabels`, the row-level Translate) legitimately answers a subset,
 * so the expected set narrows to exactly the rows the scope named — coverage is still enforced, over
 * the right set. Without this a scoped Translate would fail its own coverage check every time.
 */
function assertLabelSetMatches(
  node: string,
  rowNoun: string,
  expectedLabels: string[],
  answeredLabels: string[],
  targetLabels?: string[],
): void {
  const key = (s: string) => labelSubject(s.trim());
  let expected = new Map(expectedLabels.map((l) => [key(l), l]));
  if (targetLabels?.length) {
    const scoped = new Set(targetLabels.map(key));
    expected = new Map([...expected].filter(([k]) => scoped.has(k)));
  }
  const seen = new Set<string>();
  for (const raw of answeredLabels) {
    const k = key(raw);
    if (!expected.has(k)) {
      throw new Error(`${node}: "${raw.trim()}" is not one of the ${expected.size} ${rowNoun} this request asked about`);
    }
    if (seen.has(k)) throw new Error(`${node}: "${raw.trim()}" appears more than once`);
    seen.add(k);
  }
  const missing = [...expected].filter(([k]) => !seen.has(k)).map(([, l]) => l);
  if (missing.length > 0) {
    throw new Error(`${node}: ${missing.length} of ${expected.size} ${rowNoun} went unanswered (${missing.join(", ")})`);
  }
}

function assertIdSetMatches(
  node: string,
  context: Record<string, unknown>,
  contextKey: string,
  idField: string,
  items: IdRowResult[],
): void {
  const expected = new Set((context[contextKey] as { id: string }[]).map((r) => r.id));
  const seen = new Set<string>();
  for (const item of items) {
    const id = item[idField];
    if (!expected.has(id)) {
      throw new Error(`${node}: ${idField} "${id}" is not one of the ${expected.size} rows this request asked about`);
    }
    if (seen.has(id)) throw new Error(`${node}: ${idField} "${id}" was answered twice`);
    seen.add(id);
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((id) => !seen.has(id));
    throw new Error(`${node}: ${missing.length} of ${expected.size} rows went unanswered (${idField} ${missing.join(", ")})`);
  }
}

const NOTE_RESULTS_TOOL = idRowTool("emit_note_results", "populated Note", "pursuedNotes", "noteId");

// Tier 2 (W15d-style follow-up, M92) — noteResults reassesses ONLY finding.noteResults[].result,
// leaving the group tag on covered entries untouched and appending a new { noteId, result, group }
// entry (shape matching finding-assemble.ts's monolith build) for any note with no prior entry.
// Carries the SAME DATE AWARENESS block the monolith prompt uses for this section so a
// leaf-regenerated result doesn't regress relative to the monolith's output. Unlike studyResults there
// is no natural LABEL to echo — a note has no short hand-picked focus like Study's — so the model
// echoes the note's id instead (idEchoRule). The clinical-reasoning half (how to respond to a note) is
// vault-authored — clinical-vault/finding-dag/noteResults.md's `## Reasoning` section, synced here via
// `npm run dag:pull`.
const NOTE_RESULTS_SYSTEM_PROMPT =
  "You respond to each populated Note (pursuedNotes) — the patient's free-text jottings ahead of a " +
  "visit — grounded in the patient's overall profile (patientAssessment), lab markers (markerLevels), " +
  "and the AI Findings disease decomposition (aiFindings) supplied below. " +
  idEchoRule("pursuedNotes", "noteId") +
  "For each entry: " +
  `${dagNode("noteResults")?.reasoning} ` +
  "group: the body system this " +
  "note most directly concerns — copied VERBATIM from one of the disease[].group names in aiFindings " +
  "above. Every noteResults group MUST be one of the disease groups. " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins with " +
  "a `Today:` line carrying the current date, and every medication / supplement row in the treatment " +
  "list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active dose for " +
  "that row. • A closed range (e.g. [April–May 2026]) — this dose was active only during that window. " +
  "A row in this shape is a PRIOR dose level in a titration sequence; the row with [Since Y] for the " +
  "same drug is the current dose. A marker reading can only reflect a treatment's effect if the " +
  "reading was DRAWN DURING THE WINDOW the dose was active. Before crediting any effect, check: is the " +
  "latest reading for the marker in question dated AFTER the current dose's start (or inside a closed " +
  "range's window)? If the latest reading PRE-DATES the current dose's start, say so plainly instead " +
  "of inventing an effect. If the latest reading is too soon after the dose change to expect an effect, " +
  "say so plainly — the dose is too new to assess yet. Do not make up effects the timeline does not " +
  "support. Emit the result ONLY through the emit_note_results tool.";

const ALLERGY_RESULTS_TOOL = idRowTool("emit_allergy_results", "known allergy", "patientAllergies", "allergyId");

// M97 §C — allergyResults mirrors noteResults: an allergen name isn't guaranteed unique, so there is
// no natural label to echo; the row's id is echoed instead (idEchoRule). The clinical-reasoning half
// is vault-authored — clinical-vault/finding-dag/allergyResults.md's `## Reasoning` section, synced
// here via `npm run dag:pull`.
const ALLERGY_RESULTS_SYSTEM_PROMPT =
  "You respond to each of the patient's known allergies (patientAllergies), grounded in the patient's " +
  "overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings disease " +
  "decomposition (aiFindings) supplied below. " +
  idEchoRule("patientAllergies", "allergyId") +
  "For each entry: " +
  `${dagNode("allergyResults")?.reasoning} ` +
  "group: the body system this allergy most directly concerns — copied VERBATIM " +
  "from one of the disease[].group names in aiFindings above; if none is a genuine fit, pick the " +
  "closest one without inventing a rationale for the fit in the result text. Every allergyResults " +
  "group MUST be one of the disease groups. Emit the result ONLY through the emit_allergy_results tool.";

const FAMILY_RESULTS_TOOL = idRowTool("emit_family_results", "family history entry", "patientFamilyHistory", "familyId");

// M97 §C — familyResults mirrors allergyResults immediately above, over client.factors.familyHistory;
// same reasoning for id-echo over labels (relation/condition pairs aren't guaranteed unique). The
// clinical-reasoning half is vault-authored — clinical-vault/finding-dag/familyResults.md's
// `## Reasoning` section, synced here via `npm run dag:pull`.
const FAMILY_RESULTS_SYSTEM_PROMPT =
  "You respond to each of the patient's family history entries (patientFamilyHistory), grounded in " +
  "the patient's overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings " +
  "disease decomposition (aiFindings) supplied below. " +
  idEchoRule("patientFamilyHistory", "familyId") +
  "For each entry: " +
  `${dagNode("familyResults")?.reasoning} ` +
  "group: the body system this family history entry most directly concerns — copied VERBATIM from " +
  "one of the disease[].group names in aiFindings above; if none is a genuine fit, pick the closest " +
  "one without inventing a rationale for the fit in the result text. Every familyResults group MUST " +
  "be one of the disease groups. Emit the result ONLY through the emit_family_results tool.";

const DISEASE_RESULTS_TOOL = idRowTool("emit_disease_results", "diagnosis on file", "diagnosedDisease", "diseaseId");

// M102 — diseaseResults mirrors allergyResults exactly, over client.factors.diseases. The
// clinical-reasoning half is vault-authored — clinical-vault/finding-dag/diseaseResults.md's
// `## Reasoning` section, synced here via `npm run dag:pull`.
const DISEASE_RESULTS_SYSTEM_PROMPT =
  "You respond to each diagnosis on file (diagnosedDisease), grounded in the patient's overall " +
  "profile (patientAssessment), lab markers (markerLevels), and the AI Findings disease " +
  "decomposition (aiFindings) supplied below. " +
  idEchoRule("diagnosedDisease", "diseaseId") +
  "For each entry: " +
  `${dagNode("diseaseResults")?.reasoning} ` +
  "group: the body system this diagnosis most directly concerns — copied VERBATIM from one " +
  "of the disease[].group names in aiFindings above; if none is a genuine fit, pick the closest one " +
  "without inventing a rationale for the fit in the result text. Every diseaseResults group MUST be " +
  "one of the disease groups. Emit the result ONLY through the emit_disease_results tool.";

export const LEAF_REGEN_SPECS: Record<string, LeafRegenSpec> = {
  // W15d follow-up — aiOnPlan regenerates ONLY finding.planAssessmentRows (the holistic planAssessment
  // prose is a separate, not-yet-peeled monolith section). Uses the default generic buildContext (no
  // override): all 5 DAG inputs already have context accessors above.
  aiOnPlan: {
    node: "aiOnPlan",
    ownedSections: ["planAssessmentRows"],
    toolSchema: AI_ON_PLAN_TOOL,
    systemPromptExtra: AI_ON_PLAN_SYSTEM_PROMPT,
    isEmpty: (context) => (context.patientPlan as unknown[]).length === 0,
    validate: (raw): { rows: { action: string; assessment: string }[] } => {
      const rows = (raw as { rows?: unknown })?.rows;
      if (!Array.isArray(rows)) throw new Error("rows missing or not an array");
      for (const entry of rows) {
        const e = entry as Partial<{ action: string; assessment: string }>;
        if (typeof e?.action !== "string" || typeof e?.assessment !== "string") {
          throw new Error("row does not match { action, assessment } shape");
        }
        if (e.action.trim() === "" || e.assessment.trim() === "") throw new Error("row has an empty action or assessment");
      }
      return { rows: rows as { action: string; assessment: string }[] };
    },
    // W67 — these were in mergeInto, rebuilding plannedLabels from the MERGE-TIME client. That client
    // is not the input (applyLeafRegen merges onto whatever is live at save time), so adding a plan
    // action between fetch and apply threw on a perfectly good response. They belong against the
    // context the model actually answered, and the third rule below never existed anywhere.
    //
    // Matched by SUBJECT, not verbatim. The monolith could demand a verbatim copy because its user
    // message PRINTED the canonical labels ("Tirzepatide 9mg/week") and told it to copy them; this
    // leaf's context is patientPlan — raw treatment objects — so the model answers with the drug name
    // and nothing has ever asked it for the dose. The W65 live check found this: a real run returned
    // "Tirzepatide" against a planned label of "Tirzepatide 9mg/week". labelSubject is the codebase's
    // existing answer (treatmentAssessment's merge supersedes by it): strip the dose suffix, compare
    // the thing the row is ABOUT. A fabricated action still matches nothing and still throws.
    checkAgainstInput: (context, result) => {
      const { rows } = result as { rows: { action: string; assessment: string }[] };
      const planned = new Map(
        (context.patientPlan as TreatmentItem[]).map((t) => [labelSubject(treatmentLabel(t)), treatmentLabel(t)]),
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const subject = labelSubject(row.action.trim());
        if (!planned.has(subject)) {
          throw new Error(`aiOnPlan: action "${row.action.trim()}" matches no Patient Plan action`);
        }
        if (seen.has(subject)) throw new Error(`aiOnPlan: action "${row.action.trim()}" appears more than once`);
        seen.add(subject);
      }
      // finding-assemble.ts:544-548 makes the COVERAGE check when the monolith writes this section —
      // every planned action must actually be assessed. No leaf ever re-made it, so a short rows array
      // silently left plan items with no verdict at all, which reads in the UI as "nothing to say"
      // rather than "never asked".
      const unanswered = [...planned.entries()].filter(([subject]) => !seen.has(subject)).map(([, label]) => label);
      if (unanswered.length > 0) {
        throw new Error(`aiOnPlan: ${unanswered.length} planned action(s) went unassessed (${unanswered.join(", ")})`);
      }
    },
    mergeInto: (client, result) => {
      const { rows } = result as { rows: { action: string; assessment: string }[] };
      return { ...client, finding: { ...client.finding!, planAssessmentRows: rows } };
    },
  },
  // W15d follow-up — hypothesisEvaluation regenerates ONLY finding.decisions.patient, leaving
  // decisions.ai (the separate aiHypothesis core node) untouched. Uses the default generic
  // buildContext (no override): its DAG inputs all have context accessors above.
  hypothesisEvaluation: {
    node: "hypothesisEvaluation",
    toolSchema: HYPOTHESIS_EVALUATION_TOOL,
    systemPromptExtra: HYPOTHESIS_EVALUATION_SYSTEM_PROMPT,
    scopedArrayKey: "patient",
    isEmpty: (context) => (context.patientHypothesis as unknown[]).length === 0,
    validate: (raw): { patient: HypothesisEvaluationEntry[] } => {
      const patient = (raw as { patient?: unknown })?.patient;
      if (!Array.isArray(patient)) throw new Error("patient missing or not an array");
      for (const entry of patient) {
        const e = entry as Partial<HypothesisEvaluationEntry>;
        if (
          typeof e?.intervention !== "string" ||
          typeof e?.purpose !== "string" ||
          !Array.isArray(e?.pros) ||
          !Array.isArray(e?.cons) ||
          !Array.isArray(e?.alternatives) ||
          typeof e?.recommendation !== "string" ||
          !Array.isArray(e?.questions) ||
          e.questions.length === 0
        ) {
          throw new Error("patient entry does not match FindingDecisionEntry shape (with questions)");
        }
        // W67 — finding-assemble.ts:298-320 makes these checks on the core path. This leaf OWNS
        // decisions.patient now, so the core path never sees them: an entry with zero pros or an empty
        // recommendation rendered as a blank pros column under a heading promising one.
        assertDecisionBody(`hypothesisEvaluation "${e.intervention}"`, e as FindingDecisionEntry);
      }
      return { patient: patient as HypothesisEvaluationEntry[] };
    },
    checkAgainstInput: (context, result, targetLabels) => {
      const { patient } = result as { patient: HypothesisEvaluationEntry[] };
      assertLabelSetMatches(
        "hypothesisEvaluation",
        "ideas",
        (context.patientHypothesis as { intervention: string }[]).map((d) => d.intervention),
        patient.map((e) => e.intervention),
        targetLabels,
      );
    },
    mergeInto: (client, result) => {
      const { patient } = result as { patient: HypothesisEvaluationEntry[] };
      const merged = mergeLabeledItems(
        client.finding?.decisions?.patient ?? [],
        patient.map(({ questions: _q, ...d }) => d),
        (d) => d.intervention,
        undefined,
        // W67 — this node keys by a CONTENT label, which is exactly the case the mergeLabeledItems
        // comment above says needs subjectOf. Without it a re-answer whose label drifted appended a
        // second entry and left the stale one first, so every reader kept finding the old verdict.
        (d) => labelSubject(d.intervention),
      );
      return {
        ...client,
        finding: {
          ...client.finding!,
          decisions: { ai: client.finding?.decisions?.ai ?? [], patient: merged },
          // W65 residue — the core is told to emit decisions.patient as an empty array, and
          // doctorConversation's contract is "one group per disease, then one per patient decision,
          // then one per AI consideration". With patient empty at core time the middle band came back
          // EMPTY and nothing refilled it: measured on a real refresh, 4 patient hypotheses produced 0
          // doctor-conversation groups where the monolith produced 4. The leaf that owns
          // decisions.patient owns what is derived from it, so the questions come back with the
          // evaluation and are spliced into the same band, preserving the three-part order.
          doctorConversation: withPatientDecisionQuestions(client.finding!, merged, patient),
        },
      };
    },
  },
  // W15c/d — treatmentGroups uses id-ref tagging (S#/P#/A#/AI#), not the generic per-key context this
  // engine assembles for other nodes, so buildContext bypasses buildLeafContext and goes straight to
  // buildRegroupInputs. validate can only see the raw tool payload (no client), so the deep id-coverage
  // check (validateRegroup, which needs the same inputs buildContext produced) runs in mergeInto instead,
  // where the client is available to rebuild them — validate is a shape-only gate ahead of that.
  treatmentGroups: {
    node: "treatmentGroups",
    ownedSections: ["treatmentGroups"],
    toolSchema: TREATMENT_GROUPS_TOOL,
    systemPromptExtra: REGROUP_SYSTEM_PROMPT,
    buildContext: (client) => buildRegroupInputs(client) as unknown as Record<string, unknown>,
    isEmpty: (context) => {
      const inputs = context as unknown as RegroupInputs;
      return inputs.aiInterventions.length === 0 && inputs.patientHypotheses.length === 0 && inputs.planActions.length === 0;
    },
    validate: (raw): RegroupResponse => {
      if (!raw || typeof raw !== "object" || !Array.isArray((raw as RegroupResponse).groups)) {
        throw new Error("groups missing or not an array");
      }
      return raw as RegroupResponse;
    },
    mergeInto: (client, result) => {
      const inputs = buildRegroupInputs(client);
      const resp = result as RegroupResponse;
      validateRegroup(resp, inputs);
      const groups = resolveRegroup(resp, inputs);
      return { ...client, finding: { ...client.finding!, treatmentGroups: groups } };
    },
  },
  // Tier 2 (W15d follow-up) — treatmentAssessment regenerates finding.treatment[].assessment for
  // existing items, and appends a new { item, assessment, group } entry (shape matching
  // finding-assemble.ts's monolith build) for any item name with no prior entry — e.g. a Treatment
  // added since the last full Finding regen. Uses the default generic buildContext (no override): all
  // 4 DAG inputs (patientAssessment, markerLevels, treatmentHistory, aiFindings) already have context
  // accessors above — aiFindings already returns the full finding.disease array, which carries the
  // group names this node's cross-reference (and mergeInto's group-membership check) needs. validate
  // can only see the raw tool payload (no client), so the group-membership check runs in mergeInto
  // instead, where the client is available — same shape-only-validate / deep-check-in-mergeInto split
  // as treatmentGroups above.
  treatmentAssessment: {
    node: "treatmentAssessment",
    ownedSections: ["treatment"],
    toolSchema: TREATMENT_ASSESSMENT_TOOL,
    systemPromptExtra: TREATMENT_ASSESSMENT_SYSTEM_PROMPT,
    scopedArrayKey: "items",
    isEmpty: (context) => (context.treatmentHistory as unknown[]).length === 0,
    validate: (raw): { items: TreatmentAssessmentItem[] } => {
      const items = (raw as { items?: unknown })?.items;
      if (!Array.isArray(items)) throw new Error("items missing or not an array");
      for (const entry of items) {
        const e = entry as Partial<TreatmentAssessmentItem>;
        if (typeof e?.item !== "string" || typeof e?.assessment !== "string" || typeof e?.group !== "string") {
          throw new Error("item does not match { item, assessment, group } shape");
        }
        // W71 — the id is what pairs this prose with a drug. Without it the merge falls back to
        // substring-matching a name the model wrote itself, which is the failure this removes.
        if (typeof e?.treatmentId !== "string" || e.treatmentId.trim() === "") {
          throw new Error(`entry for "${e?.item ?? "?"}" is missing treatmentId`);
        }
      }
      return { items: items as TreatmentAssessmentItem[] };
    },
    // Against the INPUT: every id must name a treatment the model was actually shown. A hallucinated
    // or mistyped id would otherwise append a new row keyed to nothing, which reads as an assessment
    // of a drug the patient is not on.
    checkAgainstInput: (context, result) => {
      const known = new Set((context.treatmentHistory as { id: string }[]).map((t) => t.id));
      const unknown = (result as { items: TreatmentAssessmentItem[] }).items
        .map((i) => i.treatmentId)
        .filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new Error(`treatmentAssessment returned ${unknown.length} entr(ies) for unknown treatment id(s): ${[...new Set(unknown)].join(", ")}`);
      }
    },
    mergeInto: (client, result) => {
      const { items } = result as { items: TreatmentAssessmentItem[] };
      assertDiseaseGroups(client, "treatmentAssessment", items);
      // Keyed by (drug, phase), not by drug: one drug legitimately holds three entries now, and
      // keying on the drug alone would make each phase overwrite the last.
      //
      // W71 — by ID and phase where the row has one. A stored row written before this has no
      // treatmentId, so it keys by name exactly as before and is replaced by an id-keyed row the
      // first time its drug is reassessed. Mixing the two is safe because the fallback only applies
      // to rows that have nothing better.
      // Stamp an id onto any stored row that predates W71, BEFORE keying, using the same name rules
      // that produced it. Without this a legacy row keys by name while the incoming row keys by id,
      // they never match, and the first reassessment appends a second row — two assessments for one
      // drug on the patient's page.
      //
      // Match by label, requiring phase equality ONLY when the row already has a real phase: a row
      // that predates W71 predates `phase` too, so it is undefined here on every such legacy row,
      // while the schema requires the model to always return a real phase — `i.phase === row.phase`
      // therefore compared a real value against undefined and could never be true. That was the
      // actual bug: every legacy row failed to stamp, forever, so it never keyed to match an incoming
      // item and the merge silently appended an invisible duplicate on every regen instead of
      // patching the visible row. But a row can ALSO already carry a real, distinct phase while
      // merely lacking a treatmentId (multiple untagged rows for one drug, e.g. "past" and "ongoing")
      // — for those the phase check must still apply, or two such rows both match the one incoming
      // item that shares their label and collide into one.
      //
      // This is the whole of the migration, and it is deliberately confined to here: the guessing
      // happens once per row, against the answer that is already about that drug, and every row is
      // id-keyed (and phase-keyed) from then on — stamp phase too, or the freshly-id'd row still
      // fails to key-match the incoming item on THIS same pass.
      const existing = (client.finding?.treatment ?? []).map((row) => {
        if (row.treatmentId) return row;
        const phaseOk = (i: TreatmentAssessmentItem) => row.phase === undefined || i.phase === row.phase;
        const match = items.find(
          (i) => phaseOk(i) && i.item.toLowerCase().trim() === row.item.toLowerCase().trim(),
        ) ?? items.find((i) => phaseOk(i) && labelSubject(i.item) === labelSubject(row.item));
        return match ? { ...row, treatmentId: match.treatmentId, phase: match.phase } : row;
      });

      const keyed = <T extends { item: string; treatmentId?: string; phase?: Bucket }>(t: T) =>
        `${t.treatmentId ?? t.item.toLowerCase()}|${t.phase ?? ""}`;
      const subject = <T extends { item: string; treatmentId?: string; phase?: Bucket }>(t: T) =>
        `${t.treatmentId ?? labelSubject(t.item)}|${t.phase ?? ""}`;
      let treatment = mergeLabeledItems(
        existing,
        items,
        keyed,
        (item, existing) =>
          existing
            ? { ...existing, treatmentId: item.treatmentId, assessment: item.assessment, phase: item.phase }
            : { item: item.item, treatmentId: item.treatmentId, assessment: item.assessment, group: item.group, phase: item.phase },
        // The label carries that phase's dose, so it moves whenever the dose does — supersede by drug
        // WITHIN a phase, never across, or a new past entry would evict the ongoing one.
        subject,
      );
      // Retire the pre-phase entry once any phased entry exists for the same drug. Left in place it
      // is dead weight that assessmentFor would never reach, and it would keep answering as the
      // fallback for phases the model deliberately did not emit.
      // Only a PHASED arrival retires the pre-phase entry. Built from every item, this filter would
      // delete the phase-less entries it had just merged whenever the model answers without a phase.
      const phasedSubjects = new Set(items.filter((i) => i.phase).map((i) => labelSubject(i.item)));
      treatment = treatment.filter((t) => t.phase || !phasedSubjects.has(labelSubject(t.item)));
      return { ...client, finding: { ...client.finding!, treatment } };
    },
  },
  // Tier 2 (W15d follow-up) — studyResults regenerates finding.studyResults[].result for existing
  // rows, and appends a new row (study/result/group from the model, matching finding-assemble.ts's
  // monolith shape) for any label with no prior entry — e.g. a Study added since the last full
  // Finding regen. Uses the default generic buildContext (no override): all 4 DAG inputs
  // (patientAssessment, markerLevels, pursuedStudy, aiFindings) already have context accessors
  // above. validate can only see the raw tool payload (no client), so it's a shape-only gate —
  // matching is by `study` label, done in mergeInto where the existing entries are available.
  studyResults: {
    node: "studyResults",
    ownedSections: ["studyResults"],
    toolSchema: STUDY_RESULTS_TOOL,
    systemPromptExtra: STUDY_RESULTS_SYSTEM_PROMPT,
    scopedArrayKey: "items",
    isEmpty: (context) => {
      const study = context.pursuedStudy as { entries?: unknown[] } | undefined;
      return !study || !(study.entries && study.entries.length > 0);
    },
    validate: (raw): { items: { study: string; result: string; group: string }[] } => {
      const items = (raw as { items?: unknown })?.items;
      if (!Array.isArray(items)) throw new Error("items missing or not an array");
      for (const entry of items) {
        const e = entry as Partial<{ study: string; result: string; group: string }>;
        if (typeof e?.study !== "string" || typeof e?.result !== "string" || typeof e?.group !== "string") {
          throw new Error("item does not match { study, result, group } shape");
        }
        if (e.study.trim() === "" || e.result.trim() === "" || e.group.trim() === "") {
          throw new Error("item has an empty study, result or group");
        }
      }
      return { items: items as { study: string; result: string; group: string }[] };
    },
    checkAgainstInput: (context, result, targetLabels) => {
      const entries = (context.pursuedStudy as { entries?: { focus: string }[] } | undefined)?.entries ?? [];
      assertLabelSetMatches(
        "studyResults",
        "study rows",
        entries.map((e) => e.focus),
        (result as { items: { study: string }[] }).items.map((i) => i.study),
        targetLabels,
      );
    },
    mergeInto: (client, result) => {
      const { items } = result as { items: { study: string; result: string; group: string }[] };
      // W65 — the same group-membership check treatmentAssessment's mergeInto makes, for the same
      // reason and in the same place (validate sees only the raw payload; the client lives here).
      // finding-assemble.ts:218 enforces this when the MONOLITH writes studyResults; once the leaf
      // owns the section that check no longer runs, and a study tagged with a system that does not
      // exist renders under no System Analysis heading at all.
      assertDiseaseGroups(client, "studyResults", items);
      const studyResults = mergeLabeledItems(
        client.finding?.studyResults ?? [],
        items,
        (s) => s.study,
        (item, existing) =>
          existing
            ? { ...existing, result: item.result }
            : { study: item.study, result: item.result, group: item.group ?? "" },
      );
      return { ...client, finding: { ...client.finding!, studyResults } };
    },
  },
  // M92 — noteResults mirrors studyResults immediately above, minus a label field: a note has no
  // short hand-picked focus like Study's, so the model echoes the note's id. See the id-keyed row
  // leaf block above for the shared shape and why id-echo replaced position pairing.
  noteResults: {
    node: "noteResults",
    ownedSections: ["noteResults"],
    toolSchema: NOTE_RESULTS_TOOL,
    systemPromptExtra: NOTE_RESULTS_SYSTEM_PROMPT,
    buildContext: filterRowsById("noteResults", "pursuedNotes"),
    isEmpty: (context) => (context.pursuedNotes as unknown[]).length === 0,
    validate: validateIdRows("noteId"),
    checkAgainstInput: (context, result) =>
      assertIdSetMatches("noteResults", context, "pursuedNotes", "noteId", (result as { items: IdRowResult[] }).items),
    mergeInto: (client, result) => {
      const { items } = result as { items: IdRowResult[] };
      assertDiseaseGroups(client, "noteResults", items);
      const noteResults = mergeLabeledItems(
        client.finding?.noteResults ?? [],
        items.map((i) => ({ noteId: i.noteId, result: i.result, group: i.group })),
        (n) => n.noteId,
        // An existing entry keeps its group tag and takes only the fresh result — the M92 contract.
        (item, existing) => (existing ? { ...existing, result: item.result } : item),
      );
      return { ...client, finding: { ...client.finding!, noteResults } };
    },
  },
  // M97 §C — allergyResults mirrors noteResults immediately above over client.factors.allergies,
  // appending a new { allergyId, result, group } entry for any allergy with no prior entry.
  allergyResults: {
    node: "allergyResults",
    ownedSections: ["allergyResults"],
    toolSchema: ALLERGY_RESULTS_TOOL,
    systemPromptExtra: ALLERGY_RESULTS_SYSTEM_PROMPT,
    buildContext: filterRowsById("allergyResults", "patientAllergies"),
    isEmpty: (context) => (context.patientAllergies as unknown[]).length === 0,
    validate: validateIdRows("allergyId"),
    checkAgainstInput: (context, result) =>
      assertIdSetMatches("allergyResults", context, "patientAllergies", "allergyId", (result as { items: IdRowResult[] }).items),
    mergeInto: (client, result) => {
      const { items } = result as { items: IdRowResult[] };
      assertDiseaseGroups(client, "allergyResults", items);
      const allergyResults = mergeLabeledItems(
        client.finding?.allergyResults ?? [],
        items.map((i) => ({ allergyId: i.allergyId, result: i.result, group: i.group })),
        (a) => a.allergyId,
        (item, existing) => (existing ? { ...existing, result: item.result } : item),
      );
      return { ...client, finding: { ...client.finding!, allergyResults } };
    },
  },
  // M97 §C — familyResults mirrors allergyResults immediately above, sourced from
  // client.factors.familyHistory / FamilyHistoryEntry.id instead.
  //
  // M-translate — row-scoped regen (a single family entry's Translate menu item) filters
  // patientFamilyHistory down to just the target id(s) in buildContext, mirroring noteResults/
  // allergyResults above — see those specs' comments and the LeafRegenSpec interface comment.
  familyResults: {
    node: "familyResults",
    ownedSections: ["familyResults"],
    toolSchema: FAMILY_RESULTS_TOOL,
    systemPromptExtra: FAMILY_RESULTS_SYSTEM_PROMPT,
    buildContext: filterRowsById("familyResults", "patientFamilyHistory"),
    isEmpty: (context) => (context.patientFamilyHistory as unknown[]).length === 0,
    validate: validateIdRows("familyId"),
    checkAgainstInput: (context, result) =>
      assertIdSetMatches("familyResults", context, "patientFamilyHistory", "familyId", (result as { items: IdRowResult[] }).items),
    mergeInto: (client, result) => {
      const { items } = result as { items: IdRowResult[] };
      assertDiseaseGroups(client, "familyResults", items);
      const familyResults = mergeLabeledItems(
        client.finding?.familyResults ?? [],
        items.map((i) => ({ familyId: i.familyId, result: i.result, group: i.group })),
        (f) => f.familyId,
        (item, existing) => (existing ? { ...existing, result: item.result } : item),
      );
      return { ...client, finding: { ...client.finding!, familyResults } };
    },
  },
  // M102 — diseaseResults mirrors allergyResults immediately above, sourced from
  // client.factors.diseases / DiseaseEntry.id instead.
  diseaseResults: {
    node: "diseaseResults",
    ownedSections: ["diseaseResults"],
    toolSchema: DISEASE_RESULTS_TOOL,
    systemPromptExtra: DISEASE_RESULTS_SYSTEM_PROMPT,
    // Gains the scoped-row buildContext its three twins already had: with ids echoed, a row-scoped
    // Translate on a diagnosis is now correct here too rather than silently unscoped.
    buildContext: filterRowsById("diseaseResults", "diagnosedDisease"),
    isEmpty: (context) => (context.diagnosedDisease as unknown[]).length === 0,
    validate: validateIdRows("diseaseId"),
    checkAgainstInput: (context, result) =>
      assertIdSetMatches("diseaseResults", context, "diagnosedDisease", "diseaseId", (result as { items: IdRowResult[] }).items),
    mergeInto: (client, result) => {
      const { items } = result as { items: IdRowResult[] };
      assertDiseaseGroups(client, "diseaseResults", items);
      const diseaseResults = mergeLabeledItems(
        client.finding?.diseaseResults ?? [],
        items.map((i) => ({ diseaseId: i.diseaseId, result: i.result, group: i.group })),
        (d) => d.diseaseId,
        (item, existing) => (existing ? { ...existing, result: item.result } : item),
      );
      return { ...client, finding: { ...client.finding!, diseaseResults } };
    },
  },
};

// THE single place a leaf result becomes part of the Finding. Both callers go through it — the
// browser's applyLeafRegen and the CLI/orchestrator — so a leaf can never be merged one way in one
// path and another way in the other. That symmetry is the whole point of this module: the monolith
// and the leaf prompts drifted precisely because each path did its own merging.
//
// It also stamps the node's basis sentence. The core prompt no longer narrates the sections it has
// stopped writing (LEAF_OWNED_BASIS_KEYS), and DagNode.basis already holds the human sentence for
// every node, so the basis comes from the DAG rather than from a second hand-written copy.
export function mergeLeafResult(
  client: Client,
  node: string,
  validated: unknown,
  targetIds?: string[],
): Client {
  const spec = LEAF_REGEN_SPECS[node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${node}"`);
  const merged = spec.mergeInto(client, validated, targetIds);
  if (!merged.finding) return merged;
  const basis = dagNode(node)?.basis;
  // Stamped HERE, in the one merge every caller goes through, for the same reason the basis line is:
  // the browser's Translate, the relay and the CLI each reach this function and nothing else in
  // common, so a stamp applied at any single call site would be missing from the other two.
  const version = BRAIN_VERSIONS[node];
  const finding = { ...merged.finding };
  if (basis) finding.basis = { ...finding.basis, [node]: basis } as typeof finding.basis;
  if (version) finding.promptVersions = { ...finding.promptVersions, [node]: version };
  return { ...merged, finding };
}
