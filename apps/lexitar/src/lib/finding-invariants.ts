// What must be true of an ASSEMBLED Finding — core plus nine merged leaves — as opposed to a single
// model response.
//
// finding-assemble.ts's `validate()` is the response validator, and it cannot do this job. It takes a
// `FindingAIResponse`, a type structurally incapable of describing the merged article: `noteResults`
// is `{result, group}[]` there and `{noteId, result, group}[]` on `ClientFinding`, and
// `allergyResults` / `familyResults` / `diseaseResults` do not exist on it at all — so `validate()`
// cannot see three of the nine leaf sections.
//
// CORRECTION (W71): this comment used to end "so three of the nine leaf sections have never been
// checked by anything, on either path". That was false when it was written in W67, and the false
// version was copied into two plan documents from here. Those three sections ARE checked, on both
// the relay and the browser leaf paths — `validateIdRows` and `assertIdSetMatches` against the input
// the model was given, `assertDiseaseGroups` at merge. What is true is narrower, and is the actual
// reason this file exists: nothing checks them on the ASSEMBLED article, where a section can be
// inconsistent with rows no single leaf ever saw.
//
// Three of its rules are also actively WRONG after a merge and would fail every run:
//   - the drug-name dedupe (finding-assemble.ts:281), now that treatmentAssessment legitimately emits
//     one entry per phase for the same drug;
//   - `doctorConversation`'s exact length (:327), which hypothesisEvaluation's own merge can shorten
//     by filtering zero-question groups;
//   - `noteResults.length === noteIds.length` (:230), which a row-scoped Translate legitimately breaks.
// One gets STRONGER: validate() skips LEAF_OWNED_BASIS_KEYS because the core does not narrate them,
// but by merge time every leaf has stamped its own, so the whole set must be present.
//
// Returns messages rather than throwing. By the time this runs the Finding is already saved (the
// orchestrator saves per leaf, so a late failure never discards earlier work), and the policy there is
// record-and-continue — a violation is something to surface, not something to roll back.

import type { Client, FindingDecisionEntry } from "./types";
import { BASIS_KEYS } from "@pablotech/akesi/finding-assemble";
import { labelSubject } from "./leaf-regen-rows";
import { ENTITY_SPECS } from "./entity-kinds";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { bucketOf, todayISODate, treatmentLabel, assessmentFor } from "@pablotech/akesi/treatment-bucket";

/** Sections whose rows carry a body-system tag that must name a real disease group. */
const GROUP_BEARING = [
  "studyResults",
  "noteResults",
  "allergyResults",
  "familyResults",
  "diseaseResults",
  "treatment",
  "definitions",
  "dataRequisition",
] as const;

/**
 * Result sections keyed to a patient-entered row, and where that row lives.
 *
 * W70 — derived from ENTITY_KINDS rather than restated. This list and vault-item-ops' delete cascade
 * used to be two hand-written copies of the same fact, and they disagreed: four kinds here, three
 * there. This file therefore reported orphaned diagnosis reads that no code path could produce —
 * until a report deletion produced them, and nothing pruned them.
 */
const ID_KEYED = ENTITY_SPECS;

export function assembledFindingViolations(client: Client): string[] {
  const f = client.finding;
  if (!f) return [];
  const out: string[] = [];

  // 1 — body-system tags. An unknown tag does not fail visibly: system-groups.ts sweeps it into a
  // "Not yet categorized" bucket, so the row renders under a heading the clinician never chose.
  const groups = new Set((f.disease ?? []).map((d) => d.group?.trim()).filter(Boolean));
  for (const section of GROUP_BEARING) {
    const rows = (f[section] ?? []) as { group?: string }[];
    for (const [i, r] of rows.entries()) {
      if (r?.group && !groups.has(r.group.trim())) {
        out.push(`${section}[${i}] group "${r.group}" is not one of the Finding's ${groups.size} disease groups`);
      }
    }
  }

  // 2 — orphaned results. A note deleted after its result was written leaves an entry keyed to
  // nothing: invisible in the UI, but it travels in the vault and reappears if the id is ever reused.
  for (const { resultSection: section, idField, source } of ID_KEYED) {
    const rows = (f[section] ?? []) as Record<string, string>[];
    const live = new Set(((client.factors?.[source] ?? []) as { id: string }[]).map((r) => r.id));
    for (const r of rows) {
      if (!live.has(r[idField])) out.push(`${section}: ${idField} "${r[idField]}" matches no row on file`);
    }
  }

  // 3 — decision bodies. finding-assemble.ts:298-320 states these for the core path; hypothesisEvaluation
  // owns decisions.patient now, so the core path never sees that half.
  const checkDecision = (label: string, d: FindingDecisionEntry) => {
    for (const field of ["pros", "cons", "alternatives"] as const) {
      const bullets = d?.[field];
      if (!Array.isArray(bullets) || bullets.length < 2 || bullets.length > 8) {
        out.push(`${label}: ${field} must be 2-8 bullets (has ${Array.isArray(bullets) ? bullets.length : "none"})`);
      } else if (bullets.some((b) => typeof b !== "string" || b.trim().length === 0)) {
        out.push(`${label}: ${field} has a blank bullet`);
      }
    }
    if (typeof d?.recommendation !== "string" || d.recommendation.trim().length === 0) {
      out.push(`${label}: recommendation is empty`);
    }
  };
  for (const [i, d] of (f.decisions?.patient ?? []).entries()) checkDecision(`decisions.patient[${i}] (${d?.intervention})`, d);
  for (const [i, d] of (f.decisions?.ai ?? []).entries()) checkDecision(`decisions.ai[${i}] (${d?.intervention})`, d);

  // 4 — plan coverage. Compared by labelSubject, the dose-insensitive comparison aiOnPlan itself uses:
  // the plan carries "Tirzepatide 9mg/week" while the leaf answers "Tirzepatide".
  const planned = new Map(
    treatmentsOf(client)
      .filter((t) => bucketOf(t, todayISODate()) === "planned")
      .map((t) => [labelSubject(treatmentLabel(t)), treatmentLabel(t)]),
  );
  const assessed = new Set((f.planAssessmentRows ?? []).map((r) => labelSubject(r.action.trim())));
  if (planned.size > 0) {
    for (const [subject, label] of planned) {
      if (!assessed.has(subject)) out.push(`planAssessmentRows: planned action "${label}" has no assessment`);
    }
  }
  // The reverse direction, found by running this module against the live vault: Alex's plan was
  // refined from one "Mitochondrial stack" row into its four component supplements, and the old
  // assessment rows survived. aiOnPlan's checkAgainstInput rejects a fabricated action at GENERATION
  // time, but nothing ever revisits a row that was valid when written and stopped being so — it keeps
  // rendering an AI verdict on a plan item the patient no longer has.
  for (const r of f.planAssessmentRows ?? []) {
    if (!planned.has(labelSubject(r.action.trim()))) {
      out.push(`planAssessmentRows: "${r.action}" assesses an action that is no longer in the Patient Plan`);
    }
  }

  // 4b — treatment coverage, the twin of the plan rule above. Added after running this module against
  // the live vaults found 19 non-planned treatments with no LexiTar assessment at all: they render in
  // Current Treatment under a heading that promises a read, with nothing under it. The plan half of
  // this rule existed and this half did not, purely because the plan half is what I happened to be
  // looking at when I wrote it.
  //
  // assessmentFor, not a set lookup: an entry is matched per phase with a legacy no-phase fallback and
  // dose-insensitive name matching, and reimplementing that comparison here is how the backfill's own
  // predicate came to disagree with the section it fills.
  const today = todayISODate();
  for (const t of treatmentsOf(client)) {
    const phase = bucketOf(t, today);
    if (phase === "planned") continue; // covered by planAssessmentRows above, not by treatment[]
    if (!assessmentFor(f, t.name, phase, undefined, t.id)) {
      out.push(`treatment: "${treatmentLabel(t)}" (${phase}) has no assessment`);
    }
  }
  // And the reverse: an assessment for a treatment that has since been deleted.
  const liveNames = new Set(treatmentsOf(client).map((t) => labelSubject(t.name)));
  for (const e of f.treatment ?? []) {
    if (!liveNames.has(labelSubject(e.item))) {
      out.push(`treatment: "${e.item}" assesses a treatment that is no longer on file`);
    }
  }

  // 5 — doctorConversation BAND STRUCTURE, not length. The three bands are disease groups, then patient
  // decisions, then AI considerations. Length is not checkable post-merge (the patient band legitimately
  // omits a decision that came back with no questions), but ORDER is: the disease head must match
  // exactly, the AI tail must match exactly, and what sits between must be patient decisions in order.
  const dc = f.doctorConversation ?? [];
  const disease = (f.disease ?? []).map((d) => d.group?.trim());
  const aiNames = (f.decisions?.ai ?? []).map((d) => d.intervention?.trim());
  const patientNames = (f.decisions?.patient ?? []).map((d) => d.intervention?.trim());
  for (const [i, want] of disease.entries()) {
    if (dc[i] && dc[i].group?.trim() !== want) {
      out.push(`doctorConversation[${i}] should open the disease band with "${want}", has "${dc[i].group}"`);
    }
  }
  const tail = dc.slice(dc.length - aiNames.length);
  if (aiNames.length > 0 && dc.length >= disease.length + aiNames.length) {
    for (const [i, want] of aiNames.entries()) {
      if (tail[i] && tail[i].group?.trim() !== want) {
        out.push(`doctorConversation: AI band position ${i} should be "${want}", has "${tail[i].group}"`);
      }
    }
  }
  const middle = dc.slice(disease.length, dc.length - aiNames.length).map((g) => g.group?.trim());
  let cursor = 0;
  for (const name of middle) {
    const at = patientNames.indexOf(name, cursor);
    if (at === -1) {
      out.push(`doctorConversation: "${name}" sits in the patient band but is not a patient decision in order`);
      break;
    }
    cursor = at + 1;
  }

  // 6 — every basis sentence. The core narrates its own; each leaf stamps one at merge time
  // (mergeLeafResult), so an empty key means a section shipped with no provenance line under it.
  if (f.basis) {
    for (const key of BASIS_KEYS) {
      const sentence = (f.basis as unknown as Record<string, string | undefined>)[key];
      if (typeof sentence !== "string" || sentence.trim().length === 0) out.push(`basis.${key} is empty`);
    }
  }

  // 7 — treatmentGroups against decisions.ai. validateRegroup makes this check when the treatmentGroups
  // leaf SUCCEEDS; the case it cannot see is that leaf failing while the rest of the run proceeds,
  // leaving a stale grouping beside a fresh AI hypothesis. Then the Future Treatment view silently
  // omits an intervention the Finding recommends.
  if (f.treatmentGroups && aiNames.length > 0) {
    const placed = new Map<string, number>();
    for (const g of f.treatmentGroups) for (const a of g.ai ?? []) placed.set(a.trim(), (placed.get(a.trim()) ?? 0) + 1);
    for (const name of aiNames) {
      const n = placed.get(name) ?? 0;
      if (n === 0) out.push(`treatmentGroups: AI intervention "${name}" is in no group`);
      else if (n > 1) out.push(`treatmentGroups: AI intervention "${name}" is in ${n} groups`);
    }
  }

  return out;
}
