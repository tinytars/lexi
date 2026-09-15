// W72 item 16 — the brain version stamp.
//
// The stamp is only worth having if it is TRUE, so the load-bearing test here is the freshness one:
// a committed map that has drifted from the live prompts is worse than no map, because it attributes
// a section to reasoning that has since been rewritten. Everything else in this file guards the two
// ways the stamp could quietly become meaningless — an unversioned leaf, or a version defaulted in
// where the truth is "unknown".

import { describe, it, expect } from "vitest";
import { sha256hex12 } from "@pablotech/neuro/hash-node";
import { brainSourceFor, brainKeys, CORE_BRAIN, CHAT_BRAIN } from "../../src/lib/brain-source";
import { BRAIN_VERSIONS } from "../../src/lib/brain-versions";
import { brainVersions, renderModule } from "../../scripts/gen-brain-versions";
import { LEAF_REGEN_SPECS, mergeLeafResult } from "../../src/lib/leaf-regen-registry";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("the committed map matches the live prompts", () => {
  it("has not drifted — run `npm run brain:versions` if this fails", () => {
    expect(BRAIN_VERSIONS).toEqual(brainVersions());
  });

  it("is byte-identical to what the generator would write, comments included", () => {
    // Catches the other half: a correct map inside a file someone hand-edited around.
    const path = fileURLToPath(new URL("../../src/lib/brain-versions.ts", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(renderModule(brainVersions()));
  });

  it("covers the core, chat, and every leaf spec, with nothing left over", () => {
    expect(Object.keys(BRAIN_VERSIONS).sort()).toEqual([CORE_BRAIN, CHAT_BRAIN, ...Object.keys(LEAF_REGEN_SPECS)].sort());
  });

  it("gives every brain a distinct version", () => {
    const values = Object.values(BRAIN_VERSIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("what the version is computed over", () => {
  it("changes when the prompt text changes", () => {
    const before = sha256hex12(brainSourceFor("noteResults"));
    expect(sha256hex12(brainSourceFor("noteResults") + " ")).not.toBe(before);
  });

  it("distinguishes two leaves that share a base prompt", () => {
    expect(brainSourceFor("noteResults")).not.toBe(brainSourceFor("studyResults"));
  });

  it("carries the model id, so the same prompt on a different model is a different brain", () => {
    for (const key of brainKeys()) expect(brainSourceFor(key)).toMatch(/^model:\S+/);
  });

  it("carries the tool schema for a leaf, and the core has none to carry", () => {
    expect(brainSourceFor("treatmentGroups")).toContain("tool:");
    expect(brainSourceFor(CORE_BRAIN)).not.toContain("tool:");
  });

  it("is insensitive to key ORDER in a tool schema but not to its content", () => {
    // canonicalJson exists for this: re-ordering two properties of an object literal asks the model
    // exactly the same thing, and a version that moved for it would cry wolf on every tidy-up.
    const spec = LEAF_REGEN_SPECS.treatmentGroups;
    const original = spec.toolSchema as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    const source = brainSourceFor("treatmentGroups");
    try {
      (spec as { toolSchema: object }).toolSchema = reordered;
      expect(brainSourceFor("treatmentGroups")).toBe(source);
      (spec as { toolSchema: object }).toolSchema = { ...original, name: "renamed_tool" };
      expect(brainSourceFor("treatmentGroups")).not.toBe(source);
    } finally {
      (spec as { toolSchema: object }).toolSchema = original;
    }
  });

  it("refuses to invent a version for a node it does not know", () => {
    expect(() => brainSourceFor("noSuchNode")).toThrow(/no LEAF_REGEN_SPECS entry/);
  });
});

describe("stamping", () => {
  const clientWith = (finding: Record<string, unknown>) =>
    ({ id: "p", finding: { generatedAt: "", inputsHash: "", ...finding } }) as never;

  it("records the leaf's own version at the shared merge point", () => {
    // treatmentGroups' mergeInto takes the validated shape straight through; the assertion is about
    // the stamp, not the merge.
    const merged = mergeLeafResult(clientWith({ treatmentGroups: [] }), "treatmentGroups", { groups: [] });
    expect(merged.finding?.promptVersions?.treatmentGroups).toBe(BRAIN_VERSIONS.treatmentGroups);
  });

  it("leaves other leaves' versions alone", () => {
    const prior = clientWith({ treatmentGroups: [], promptVersions: { noteResults: "deadbeef0000" } });
    const merged = mergeLeafResult(prior, "treatmentGroups", { groups: [] });
    expect(merged.finding?.promptVersions?.noteResults).toBe("deadbeef0000");
  });

  it("does not backfill a version onto a section it did not write", () => {
    // The whole value of the stamp is the join it enables. A Finding whose sections predate this
    // feature must read UNKNOWN, not "whatever is current" — a defaulted version is a wrong answer
    // that looks like a right one.
    const merged = mergeLeafResult(clientWith({ treatmentGroups: [] }), "treatmentGroups", { groups: [] });
    expect(Object.keys(merged.finding?.promptVersions ?? {})).toEqual(["treatmentGroups"]);
    expect(merged.finding?.promptVersions?.[CORE_BRAIN]).toBeUndefined();
  });
});
