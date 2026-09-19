import { describe, it, expect } from "vitest";
import { AI_ON_PLAN_SYSTEM_PROMPT, TREATMENT_ASSESSMENT_SYSTEM_PROMPT } from "../../src/lib/leaf-regen-prompts";
import { CURRENT_DOSE_RULE, CO_MENTION_RULE, BUCKET_DOSE_RULE, STANDARD_DOSING_RULE } from "@pablotech/akesi/treatment-timing-rules";
import { SYSTEM_PROMPT } from "@pablotech/akesi/finding-generate";

describe("leaf-regen-prompts: treatmentAssessment", () => {
  it("tells the model to use dailyTotal directly rather than re-deriving one", () => {
    expect(TREATMENT_ASSESSMENT_SYSTEM_PROMPT).toMatch(/dailyTotal/);
  });

  // Regression: a mid-titration dose was read off a scheduled future row instead of the one whose window contains today.
  it("system prompt defines the current dose as the row whose window contains today, not the newest row", () => {
    expect(TREATMENT_ASSESSMENT_SYSTEM_PROMPT).toContain(CURRENT_DOSE_RULE);
  });

  // Regression: an ended regimen was described in present tense with one of its many rows as "the current dose".
  it("system prompt forbids present tense for past regimens and reads a bucket as a trajectory", () => {
    expect(TREATMENT_ASSESSMENT_SYSTEM_PROMPT).toContain(BUCKET_DOSE_RULE);
  });

  it("system prompt places a dose against the drug's standard range", () => {
    expect(TREATMENT_ASSESSMENT_SYSTEM_PROMPT).toContain(STANDARD_DOSING_RULE);
  });
});

// The whole-Finding "↻ Translate" (Provider Access pulldown) regenerates through the MONOLITH prompt,
// not these per-node ones. Both carried their own copy of the timing rules, so correcting one left
// the other free to reintroduce the same errors on the next full regeneration. They now share one
// source; this asserts neither path can drift from it again.
describe("treatment timing rules are shared by both prompt paths", () => {
  const monolith = SYSTEM_PROMPT;

  // The monolith no longer writes the treatment section, so the leaf prompt is the co-mention rule's only home.
  it("the co-mention rule lives in the leaf prompt only, now that the monolith has no treatment section", () => {
    const unwrap = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(unwrap(TREATMENT_ASSESSMENT_SYSTEM_PROMPT)).toContain(unwrap(CO_MENTION_RULE));
    expect(unwrap(monolith)).not.toContain(unwrap(CO_MENTION_RULE));
    // The monolith keeps CURRENT_DOSE_RULE: it still describes the treatment HISTORY it is given as
    // input (treatmentHistory), even though it no longer writes the treatment section.
    expect(unwrap(monolith)).toContain(unwrap(CURRENT_DOSE_RULE));
  });

  // The duplication these constants exist to prevent: a correction landing in one prompt path and
  // silently missing the other.
  it("the monolith Finding prompt carries the same bucket-tense and standard-dosing rules", () => {
    const unwrap = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(unwrap(monolith)).toContain(unwrap(BUCKET_DOSE_RULE));
    expect(unwrap(monolith)).toContain(unwrap(STANDARD_DOSING_RULE));
  });
});

// aiOnPlan handles planned items and once lacked the dose rules treatmentAssessment had.
describe("both treatment-facing prompts carry the same rules", () => {
  it("aiOnPlan now gets the bucket-tense and standard-dosing rules too", () => {
    const plan = AI_ON_PLAN_SYSTEM_PROMPT;
    expect(plan).toContain(BUCKET_DOSE_RULE);
    expect(plan).toContain(STANDARD_DOSING_RULE);
    expect(plan).toContain(CO_MENTION_RULE);
  });
});
