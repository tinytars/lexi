// W18 — the report's sections for the sectioned screen tabs (AI Thoughts, Doctor Conversation,
// Critical Ratios). Each entry names the persona-mapped component that renders it (see the kind
// switch in ReportSections.svelte). Presence predicates keep a section with no content from
// showing an empty sub-tab. W24 retired the monolithic FullReport PDF; every section is now its
// own on-screen component.

import type { Client } from "./types";
import { dcSlices } from "./doctor-conversation";
import { PRODUCT_NAME } from "./brand";
import { SECTION_LABEL } from "@pablotech/akesi/section-labels";

export interface SectionMeta {
  key: string;
  label: string;
  // M84 — one small emoji per sidebar row, mirroring nav.ts's per-tab icon.
  icon: string;
  // W37 — the subsection-level half of the unified description system: a short, patient-facing line
  // rendered once in ReportSections.svelte for the active subsection.
  blurb: string;
  // W63 — `nodeKey`/`nodeKeys` used to live here, naming the finding-dag node(s) a section renders,
  // to drive a per-section "stale" chip. W15b added them; M75's sidebar rewrite dropped the chip and
  // left the fields and their 9 populated entries behind, read by nothing. Staleness itself is
  // untouched — it lives in staleness.ts and the DAG view, which key off findingDag directly.
  // Every section renders its own persona-mapped component (W24 retired the FullReport PDF slice).
  kind:
    | "healthReports"
    | "treatment"
    | "futureTreatment"
    | "glossary"
    | "questionsForDr"
    | "markers"
    | "personalization"
    | "analysis"
    | "exploration"
    | "study"
    | "notes"
    | "allergies"
    | "familyHistory"
    | "healthMarkers";
}

// The slice itself lives in doctor-conversation.ts — one arithmetic, three readers (W76). What is
// here is only the presence question each sub-tab asks of it.
function dcGroupCounts(c: Client): { inference: number; patient: number; ai: number } {
  const s = dcSlices(c);
  return { inference: s.inference.length, patient: s.patient.length, ai: s.ai.length };
}

const PRESENCE: Record<string, (c: Client) => boolean> = {
  // AI Thoughts — the four parts of the AI Findings section.
  healthProgression: (c) => !!c.finding,
  study: (c) =>
    !!c.finding?.studyResults?.length ||
    !!(c.study && c.study.entries?.length),
  healthFinding: (c) => !!c.finding,
  treatmentAssessment: (c) => !!c.finding,
  // Doctor Conversation — its three question groups.
  docInference: (c) => dcGroupCounts(c).inference > 0,
  docPatient: (c) => dcGroupCounts(c).patient > 0,
  docAi: (c) => dcGroupCounts(c).ai > 0,
  // Treatment (ongoing / planned / past) — always available so the patient can add their first
  // one; UnifiedTreatment.svelte already renders a proper empty state + "+ Add treatment".
  treatment: () => true,
  // Speculation is the patient's weighed hypotheses ↔ AI's; the committed Plan lives in Treatment Plan.
  futureTreatment: (c) => !!(c.finding?.decisions?.ai?.length || c.factors?.decisions?.length),
  // Health Reports — the imported source files.
  healthReports: (c) => !!c.sources?.length,
  // Markers — folded in from the retired top-level tab; always available in Terminology Translator.
  markers: () => true,
  // Personalization — the profile/conditions/correlations editor (Patient → Profile, W37); always available.
  personalization: () => true,
  // Analysis — the consolidated analytical read (W34); its child blocks each handle their own empty state.
  analysis: (c) => !!c.finding,
  // Exploration (M80, promoted out of Analysis) — additional tests the AI suggests obtaining next.
  exploration: (c) => !!c.finding?.dataRequisition?.length,
  // Notes (M63) — a free-text scratchpad, always available so the patient can add their first note.
  notes: () => true,
  // PDF-only sections (never surfaced as a screen sub-tab, still printed).
  aiHypothesis: (c) => !!c.finding?.decisions?.ai?.length,
  hypothesisEvaluation: (c) =>
    !!c.finding?.decisions && (c.finding.decisions.patient.length > 0 || c.finding.decisions.ai.length > 0),
  healthMarkers: (c) => !!c.finding?.healthMarkers?.recommended?.some((g) => g.markers?.length),
  longitudinalChange: (c) => c.results.length > 1,
  clinicalSynthesis: (c) => !!c.finding?.clinicalSynthesis,
  patternAntipattern: (c) => !!c.finding?.patternAntipattern,
  finalThoughts: (c) => !!c.finding?.finalThoughts,
  aiConclusion: (c) => !!c.finding,
  definitions: (c) => !!c.finding?.definitions?.length,
};

export function isSectionPresent(client: Client, key: string): boolean {
  const p = PRESENCE[key];
  return p ? p(client) : true;
}

export function presentSections(client: Client, sections: SectionMeta[]): SectionMeta[] {
  return sections.filter((s) => isSectionPresent(client, s.key));
}

// The Research tab (provider-only, W34/W35). Analysis leads: one subsection stacking the former Health
// Progression, System Analysis, and AI Conclusion blocks (M80 flattened AI Conclusion's 3 children to
// top-level, sidebar-navigable blocks). Study (the patient's pursued-study rows paired with the AI's
// answers, editable in place) sits next, then Hypothesis (the weighed patient↔AI hypotheses, grouped by
// body system), then Exploration last (M80 — promoted out of Analysis, additional tests the AI suggests
// obtaining next, grouped by risk area like Labs → Markers). W37 moved Personalization out to the
// Patient tab (→ Profile).
export const AI_SECTIONS: SectionMeta[] = [
  { key: "analysis", label: SECTION_LABEL.analysis, icon: "🧠", kind: "analysis", blurb: `${PRODUCT_NAME}'s overall read of your health — how things have changed, patterns across body systems, and where to look next.` },
  { key: "study", label: SECTION_LABEL.study, icon: "🔬", kind: "study", blurb: `Topics you chose to look into, each paired with what ${PRODUCT_NAME} found.` },
  { key: "futureTreatment", label: SECTION_LABEL.futureTreatment, icon: "💡", kind: "futureTreatment", blurb: `Possible treatments worth exploring — your ideas and ${PRODUCT_NAME}'s — weighed but not yet a plan.` },
  { key: "exploration", label: SECTION_LABEL.exploration, icon: "🧭", kind: "exploration", blurb: `Additional data ${PRODUCT_NAME} suggests obtaining next, grouped by body system.` },
];

// The Patient tab. Treatment leads (M65 — the editable Treatment list), then Profile (W37 — the
// folded-in profile editor, patient-visible + editable), then Allergies and Family (M65 — new
// subsections). Exploration folded into Research → Analysis (W34). Symptoms (was here, "conditions"
// kind) was fully deprecated and removed — see git history for its shape if reviving it.
export const DOCTOR_SECTIONS: SectionMeta[] = [
  { key: "treatment", label: SECTION_LABEL.treatment, icon: "💊", kind: "treatment", blurb: `Drugs, supplements, and behaviors on one timeline — planned, ongoing, or stopped — each with ${PRODUCT_NAME}'s take.` },
  { key: "personalization", label: SECTION_LABEL.personalization, icon: "👤", kind: "personalization", blurb: `Your basic details — these personalize your healthy ranges and ${PRODUCT_NAME}'s read of your results. Each field persists as soon as you leave it.` },
  { key: "allergies", label: SECTION_LABEL.allergies, icon: "⚠️", kind: "allergies", blurb: "Substances and drugs you're known to react to, so your care team can avoid them." },
  { key: "familyHistory", label: SECTION_LABEL.familyHistory, icon: "👪", kind: "familyHistory", blurb: "Conditions that run in your family, which can shape your own risk." },
];

// The Labs tab. Markers wall leads (folded in from the retired top-level tab), then Reports (the
// imported source documents).
export const LABS_SECTIONS: SectionMeta[] = [
  { key: "markers", label: SECTION_LABEL.markers, icon: "📊", kind: "markers", blurb: "Your lab and measurement results over time, grouped by body system, each shown against your personal healthy range." },
  { key: "healthReports", label: SECTION_LABEL.clinicalReports, icon: "📄", kind: "healthReports", blurb: `Your hospital reports, each with the doctor's diagnosis and a plain-language ${PRODUCT_NAME} summary of the details.` },
];

// The Appointment tab. Notes (M63 — a free-text scratchpad, leftmost), then Questions (for the
// doctor), then the Glossary (rightmost).
export const APPOINTMENT_SECTIONS: SectionMeta[] = [
  { key: "notes", label: SECTION_LABEL.notes, icon: "📝", kind: "notes", blurb: `A place to jot things down before your appointment, each paired with what ${PRODUCT_NAME} found.` },
  { key: "docInference", label: SECTION_LABEL.docInference, icon: "❓", kind: "questionsForDr", blurb: "Questions worth raising with your care team, drawn from your data." },
  // W61 — moved off Investigator: it renders nested under Notes now (between Questions and
  // Glossary), so it belongs to the patient side like its two neighbours. The label stays
  // "Recommended Markers" here even though the sidebar row reads "Markers" — this label heads its
  // SEARCH group, where "Markers" alone would be indistinguishable from the marker wall's.
  { key: "healthMarkers", label: SECTION_LABEL.healthMarkers, icon: "📈", kind: "healthMarkers", blurb: `Markers ${PRODUCT_NAME} recommends tracking, grouped by body system, with the reasoning behind each.` },
  { key: "definitions", label: SECTION_LABEL.definitions, icon: "📖", kind: "glossary", blurb: "Plain-language definitions of the terms and abbreviations used across your record." },
];

// M83 — Labs + Doctor + Appointment consolidated into the sidebar's "Patient" toggle mode
// (Sidebar.svelte's other toggle option, "Investigator", is AI_SECTIONS on its own).
// W46 — Notes/Questions are pulled to the front (Search → Chat → Notes → Questions is the sidebar's
// target lead-in), so this is no longer LABS/DOCTOR/APPOINTMENT
// concatenated in tab order — it's an explicit key order assembled from all three. Every entry still
// stays inside its *owning* array (LABS_SECTIONS/DOCTOR_SECTIONS/APPOINTMENT_SECTIONS) unchanged —
// permalink.ts's SECTION_TAB reverse map (used by ~13 "Chat about this" reference cards) resolves a
// section's owning tab from those arrays, not from this order.
// W48 — Profile (personalization) moved from last (after Glossary, M84) to right after Treatment,
// with Allergies/Family immediately following it: Sidebar.svelte now renders Allergies/Family only
// nested inside Profile's own lower-zone group list (Bio/Allergies/Family), not as flat top-level
// rows — but they stay full members of this array (just reordered), since sidebar-mode.ts's
// modeForSection(), permalink.ts's SECTION_KEYS/SECTION_TAB, and visibility.ts's FEATURES (the
// per-key patient-visibility toggle — Family can still be hidden independently of Allergies) all key
// off membership here, not display order or which component renders the row.
// docInference (Questions) and definitions (Glossary) are no longer top-level rows — they render as
// group rows INSIDE Notes (see notesSidebarGroups). They stay full members of this array because
// modeForSection(), permalink.ts's SECTION_KEYS/SECTION_TAB and visibility.ts's FEATURES all key off
// membership, not display order; Sidebar.svelte filters them out of the flat row list, exactly as it
// already does for allergies/familyHistory nested under Profile.
const PATIENT_SECTION_ORDER = [
  "notes", "docInference", "healthMarkers", "definitions", "treatment", "markers",
  "healthReports", "personalization", "allergies", "familyHistory",
];
const ALL_PATIENT_CANDIDATES = [...LABS_SECTIONS, ...DOCTOR_SECTIONS, ...APPOINTMENT_SECTIONS];
export const PATIENT_SECTIONS: SectionMeta[] = PATIENT_SECTION_ORDER.map(
  (key) => ALL_PATIENT_CANDIDATES.find((s) => s.key === key)!,
);
// M82 Phase 1 — flat concatenation of every section array, same order as the original tab bar
// (labs, doctor, appointment, ai). Consumed by permalink.ts's SECTION_TAB/section-key lookups.
export const ALL_SECTIONS: SectionMeta[] = [...PATIENT_SECTIONS, ...AI_SECTIONS];

// 06/Gap B — the table itself now lives in section-labels.ts (branding-free, so pinned-queries.ts
// can read it without pulling in @tars/brand). Re-exported here so existing importers of this
// module are untouched. These strings reach the LLM prompt and the staleness hash, so a second
// spelling would not be cosmetic — every SectionMeta.label above is sourced from the same table.
export { SECTION_LABEL } from "@pablotech/akesi/section-labels";
