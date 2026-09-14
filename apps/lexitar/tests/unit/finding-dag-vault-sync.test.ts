import { describe, expect, it } from "vitest";
import { appendReasoning } from "../../scripts/export-finding-dag-vault";
import { extractReasoning } from "../../scripts/import-finding-dag-vault";

// Round-trip coverage for the `## Reasoning` section: dag:push (appendReasoning) writes it into a
// vault note, dag:pull (extractReasoning) reads it back out. Both live in apps/health-dash-web, not
// @pablotech/neuro-pil — see import-finding-dag-vault.ts's header for why.

describe("finding-dag vault ## Reasoning round-trip", () => {
  const NOTE = `---
node: clinicalSynthesis
kind: derived
label: "Clinical Synthesis"
inputs: [diagnosedDisease]
basis: "Two-track synthesis."
tags: [dag/derived]
---

# Clinical Synthesis

Two-track synthesis.

## Inputs

- [[diagnosedDisease]]
`;

  it("round-trips realistic clinical prose — em dashes, nested quotes, multi-paragraph", () => {
    const reasoning =
      'Quote the source\'s EXACT descriptor for BOTH endpoints — e.g. "left atrial volume ' +
      'index 29 mL/m²" (2019) → "Moderately dilated left atrium" (2024).\n\n' +
      'Never lead with a derived number without the two quoted endpoints behind it.';

    const written = appendReasoning(NOTE, reasoning);
    expect(extractReasoning(written)).toBe(reasoning);
  });

  it("appendReasoning leaves content unchanged when reasoning is undefined", () => {
    expect(appendReasoning(NOTE, undefined)).toBe(NOTE);
  });

  it("extractReasoning returns undefined when there is no ## Reasoning heading", () => {
    expect(extractReasoning(NOTE)).toBeUndefined();
  });

  it("extractReasoning stops at the next ## heading rather than swallowing it", () => {
    const withTrailingSection = appendReasoning(NOTE, "adverse and favorable, always.") + "\n## Not Reasoning\n\nsome other section\n";
    expect(extractReasoning(withTrailingSection)).toBe("adverse and favorable, always.");
  });

  it("appendReasoning is the exact inverse of extractReasoning for the live clinicalSynthesis text", () => {
    // Guards the specific shape this segment migrated: indentation carried over from the multi-line
    // array-string-literal source, en/em dashes, an inline arrow.
    const reasoning = "This is the two-track TRAJECTORY narrative a\n  clinician delivers — it SYNTHESIZES across findings already established\n  elsewhere in this report.";
    const written = appendReasoning(NOTE, reasoning);
    expect(written).toContain("## Reasoning\n\n" + reasoning);
    expect(extractReasoning(written)).toBe(reasoning);
  });
});
