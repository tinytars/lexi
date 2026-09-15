import { describe, it, expect } from "vitest";
import { BASE_SYSTEM_PROMPT, LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";

// W?? — 55df014 found treatmentAssessment's "INTERACTIONS WITH OTHER TREATMENTS" paragraph forcing
// up to 3 re-scans of the full unscoped vault context (48 treatments for Alex) per assessed item,
// which timed out a live Fish Oil dose edit against the 120s client deadline. treatmentAssessment has
// no buildContext scoping (unlike its siblings), so its prompt size is the whole guard against that
// class of regression — nothing else catches a paragraph like that being re-added. Measured directly
// (not estimated): post-fix combined length is ~15,216 chars; the removed paragraph alone was ~1,783
// chars, putting the pre-fix prompt at ~16,999. The ceiling sits between those two so it fails if that
// paragraph, or anything similarly sized, comes back, while leaving room for ordinary edits.
const TREATMENT_ASSESSMENT_PROMPT_CHAR_CEILING = 16_000;

describe("treatmentAssessment prompt stays inside its budget", () => {
  it("system prompt does not silently regrow past the ceiling", () => {
    const spec = LEAF_REGEN_SPECS.treatmentAssessment;
    const combined = `${BASE_SYSTEM_PROMPT}\n\n${spec.systemPromptExtra}`;
    expect(
      combined.length,
      `treatmentAssessment system prompt is ${combined.length} chars, over the ${TREATMENT_ASSESSMENT_PROMPT_CHAR_CEILING} budget — see 55df014`,
    ).toBeLessThanOrEqual(TREATMENT_ASSESSMENT_PROMPT_CHAR_CEILING);
  });
});
