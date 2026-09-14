import { describe, it, expect } from "vitest";
import { canSee, patientCanSee, FEATURES } from "../../src/lib/visibility";
import { SECTION_LABEL } from "../../src/lib/report-sections";
import type { Client } from "../../src/lib/types";

const base = (pv?: Record<string, boolean>): Client => ({
  displayName: "P", dob: "1980-01-01", gender: "male", watchlist: [], results: [], patientVisibility: pv,
});

describe("visibility catalog + policy", () => {
  it("Analysis and Hypothesis default to provider-only; the rest patient-visible (W37 made Profile/personalization patient-visible)", () => {
    const c = base();
    expect(patientCanSee(c, "analysis")).toBe(false);
    expect(patientCanSee(c, "futureTreatment")).toBe(false);
    expect(patientCanSee(c, "personalization")).toBe(true);
    expect(patientCanSee(c, "healthReports")).toBe(true);
    expect(patientCanSee(c, "treatment")).toBe(true);
    expect(patientCanSee(c, "chat")).toBe(true);
  });

  it("a provider override wins over the catalog default (both directions)", () => {
    expect(patientCanSee(base({ analysis: true }), "analysis")).toBe(true);
    expect(patientCanSee(base({ healthReports: false }), "healthReports")).toBe(false);
  });

  it("an uncatalogued key fails open (visible)", () => {
    expect(patientCanSee(base(), "brandNewFeature")).toBe(true);
  });

  it("the provider sees everything; a patient session honors the policy", () => {
    const c = base({ analysis: false, chat: false });
    expect(canSee(true, c, "analysis")).toBe(true);
    expect(canSee(true, c, "chat")).toBe(true);
    expect(canSee(false, c, "analysis")).toBe(false);
    expect(canSee(false, c, "chat")).toBe(false);
  });

  it("the catalog covers every nav tab and report-section key", () => {
    const keys = new Set(FEATURES.map((f) => f.key));
    // M82 P6 removed the labs/doctor/appointment/ai tab-kind entries as redundant with their
    // already-gated children; chat is the only tab-kind entry left (no children of its own).
    expect(keys.has("chat")).toBe(true);
    for (const k of ["labs", "doctor", "appointment", "ai"]) expect(keys.has(k)).toBe(false);
    expect(keys.has("profile")).toBe(false);
    // W34 merged Health Progression + System Analysis + AI Conclusion → analysis. M80 promoted
    // Exploration back out to its own top-level subsection.
    for (const k of ["personalization", "analysis", "futureTreatment", "exploration", "healthReports", "markers", "treatment", "docInference", "definitions"]) {
      expect(keys.has(k)).toBe(true);
    }
  });
});

// W62 P8 — the section display name existed in three tables and two of them had drifted
// ("Recommended markers" vs "Recommended Markers", "Family history" vs "Family"). pinned-queries
// now derives its labels from report-sections' SECTION_LABEL; this catalogue still declares its
// own, because it carries kind/defaultAudience that report-sections has no opinion on. That makes
// this the remaining seam — assert it rather than let it drift a second time.
describe("section labels agree with report-sections", () => {
  it("every catalogued section spells its label the way the app does", () => {
    for (const f of FEATURES) {
      if (f.kind !== "section") continue;
      const canonical = SECTION_LABEL[f.key];
      if (!canonical) continue; // a feature with no section of its own (e.g. a tab-level toggle)
      expect(`${f.key}: ${f.label}`).toBe(`${f.key}: ${canonical}`);
    }
  });
});
