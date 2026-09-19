import { describe, it, expect } from "vitest";
import { LEAF_REGEN_SPECS } from "../../src/lib/leaf-regen-registry";
import { client } from "../fixtures/leaf-regen-client";

const srSpec = LEAF_REGEN_SPECS.studyResults;

describe("leaf-regen-specs: studyResults", () => {
  it("registers a spec with its own tool schema, using the default generic buildContext", () => {
    expect(srSpec).toBeDefined();
    expect((srSpec.toolSchema as { name: string }).name).toBe("emit_study_results");
    expect(srSpec.buildContext).toBeUndefined();
  });

  it("isEmpty is true only when entries are absent", () => {
    expect(srSpec.isEmpty!({ pursuedStudy: {} })).toBe(true);
    expect(srSpec.isEmpty!({ pursuedStudy: { entries: [] } })).toBe(true);
    expect(srSpec.isEmpty!({ pursuedStudy: { entries: [{ focus: "Selection", detail: "y" }] } })).toBe(false);
  });

  it("validate accepts a well-formed items array and rejects a malformed payload", () => {
    const good = { items: [{ study: "Suspicion", result: "Consistent with early insulin resistance.", group: "Cardiovascular Risk" }] };
    expect(srSpec.validate(good)).toEqual(good);
    expect(() => srSpec.validate({})).toThrow(/items missing/);
    expect(() => srSpec.validate({ items: [{ study: "x" }] })).toThrow(/study, result, group/);
  });

  it("mergeInto updates only the matched study label's result, leaving study/group and unmatched entries untouched", () => {
    const c = client();
    const result = { items: [{ study: "Suspicion", result: "Refreshed read.", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults).toEqual([{ study: "Suspicion", result: "Refreshed read.", group: "Cardiovascular Risk" }]);
    // the original client is untouched (mergeInto returns a new object)
    expect(c.finding!.studyResults![0].result).toBe("old result");
  });

  it("mergeInto leaves an existing entry untouched when its study label isn't among the returned items", () => {
    const c = client();
    const result = { items: [{ study: "Symptoms", result: "x", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults![0]).toEqual(c.finding!.studyResults![0]);
  });

  it("mergeInto appends a new entry for a study label with no prior finding.studyResults row (e.g. a Study added since the last full regen)", () => {
    const c = client();
    const result = { items: [{ study: "Symptoms", result: "Newly generated read.", group: "Cardiovascular Risk" }] };
    const updated = srSpec.mergeInto(c, result);
    expect(updated.finding!.studyResults).toEqual([
      { study: "Suspicion", result: "old result", group: "Cardiovascular Risk" },
      { study: "Symptoms", result: "Newly generated read.", group: "Cardiovascular Risk" },
    ]);
  });
});
