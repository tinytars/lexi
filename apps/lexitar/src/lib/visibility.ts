// W15/3a — the provider-configurable patient-visibility policy. A generic catalog of
// features (tabs + report sections) each with a default audience; the provider overrides
// per patient via client.patientVisibility. The provider always sees everything; a
// patient's own session sees only patient-audience features. Render-gate only (Option A):
// the config lives in the patient's own vault, so it's a product-surface control, not a
// cryptographic secret. Actions that spend/mutate (refresh) get a real server gate (3b).
import type { Client } from "./types";

export type Audience = "provider" | "patient";

export interface Feature {
  key: string; // a nav Tab id or a report-sections SectionMeta key (no collisions)
  label: string;
  kind: "tab" | "section";
  defaultAudience: Audience;
}

// Keys mirror src/lib/nav.ts (tabs) and src/lib/report-sections.ts (section keys) verbatim.
// Keep this catalog in lockstep with those two files: when a feature moves, is renamed, merged,
// or retires, update the entry here (key + kind + label) in the same change — otherwise the
// Visibility panel mislabels it and the section can silently fall to the fail-open default.
export const FEATURES: Feature[] = [
  // chat has no independently-gated children of its own (no SectionMeta), so this is the only
  // remaining way to hide the whole Chat tab per-patient -- the other 4 tab-kind entries
  // (labs, doctor, appointment, ai) were redundant with their already-gated children and were
  // removed.
  { key: "chat", label: "Chat", kind: "tab", defaultAudience: "patient" },
  // W35 — Research (ex-AI Thoughts) holds provider-only content (Analysis + Study + Hypothesis +
  // Exploration); the tab itself has no FEATURES entry since it's fully composed of these
  // independently-gated sub-sections (Analysis merges Health Progression + On Treatment + System
  // Analysis + AI Conclusion's 3 children; Study is its own subsection with in-place CRUD;
  // Hypothesis is the weighed patient↔AI hypotheses; Exploration (M80, promoted out of Analysis)
  // is additional tests the AI suggests, grouped by risk area).
  { key: "analysis", label: "Analysis", kind: "section", defaultAudience: "provider" },
  { key: "study", label: "Study", kind: "section", defaultAudience: "provider" },
  { key: "futureTreatment", label: "Hypothesis", kind: "section", defaultAudience: "provider" },
  { key: "exploration", label: "Exploration", kind: "section", defaultAudience: "provider" },
  // M97 §F (Phase 6, partial) — Recommended Markers joins this same provider-only group (see
  // RecommendedMarkers.svelte); without this entry it fail-opens to patient-visible, inconsistent
  // with its Investigator siblings above.
  { key: "healthMarkers", label: "Recommended Markers", kind: "section", defaultAudience: "patient" },
  // Patient tab sub-sections (Treatment · Profile · Allergies · Family). W37 — Profile (the
  // folded-in profile editor) moved here and is now patient-visible + editable.
  { key: "personalization", label: "Profile", kind: "section", defaultAudience: "patient" },
  { key: "healthReports", label: "Reports", kind: "section", defaultAudience: "patient" },
  { key: "markers", label: "Markers", kind: "section", defaultAudience: "patient" },
  { key: "treatment", label: "Treatment", kind: "section", defaultAudience: "patient" },
  { key: "notes", label: "Notes", kind: "section", defaultAudience: "patient" },
  { key: "docInference", label: "Questions", kind: "section", defaultAudience: "patient" },
  { key: "definitions", label: "Glossary", kind: "section", defaultAudience: "patient" },
  { key: "allergies", label: "Allergies", kind: "section", defaultAudience: "patient" },
  { key: "familyHistory", label: "Family", kind: "section", defaultAudience: "patient" },
];

const DEFAULT_AUDIENCE: Map<string, Audience> = new Map(FEATURES.map((f) => [f.key, f.defaultAudience]));

// Would a patient's own session see this feature? Provider override wins; else the default.
// Unknown keys default visible (fail-open — a new feature isn't hidden until catalogued).
export function patientCanSee(client: Client, key: string): boolean {
  const override = client.patientVisibility?.[key];
  if (typeof override === "boolean") return override;
  return (DEFAULT_AUDIENCE.get(key) ?? "patient") === "patient";
}

// The enforcement predicate. The provider (drilled-in) sees everything; a patient sees
// only patient-audience features.
export function canSee(providerSession: boolean, client: Client | null | undefined, key: string): boolean {
  if (providerSession) return true;
  return client ? patientCanSee(client, key) : true;
}
