import { describe, it, expect } from "vitest";
import { groupBySlug, withKeys } from "../../scripts/raw-encrypt-backfill";
import type { Vault } from "../../src/lib/types";

// The sweep overwrites patient objects in place under keys it writes into someone else's vault, so
// what is worth pinning here is the two pure steps that decide WHERE a key lands: which objects
// belong to one patient, and that recording their keys disturbs nothing else in the vault.

describe("groupBySlug", () => {
  it("collects one patient's objects under their slug", () => {
    expect(groupBySlug(["prod/raw/alex/a.pdf", "prod/raw/sam/b.pdf", "prod/raw/alex/c.pdf"])).toEqual(
      new Map([
        ["alex", ["prod/raw/alex/a.pdf", "prod/raw/alex/c.pdf"]],
        ["sam", ["prod/raw/sam/b.pdf"]],
      ]),
    );
  });

  // A transcription sidecar is sealed under the SAME content key as the document it transcribes, so
  // it has to reach the same vault, and one sweep of the namespace has to see both.
  it("puts a text sidecar with the document it transcribes", () => {
    expect(groupBySlug(["prod/raw/alex/a.pdf", "prod/text/alex/a.pdf.json"])).toEqual(
      new Map([["alex", ["prod/raw/alex/a.pdf", "prod/text/alex/a.pdf.json"]]]),
    );
  });

  it("drops a key that is not a raw object, rather than inventing a slug for it", () => {
    expect(groupBySlug(["prod/data-alex.enc"])).toEqual(new Map());
  });
});

describe("withKeys", () => {
  it("records the new keys under the patient's slug", () => {
    expect(withKeys({ clients: {} } as Vault, "alex", { "a.pdf": "K" }).rawKeys).toEqual({ alex: { "a.pdf": "K" } });
  });

  // The window this cannot close is a browser saving the vault mid-sweep, so the merge keeps every
  // key already there: overwriting the ring would make whatever the browser just sealed unopenable.
  it("keeps the keys the vault already held for that patient", () => {
    const before = { clients: {}, rawKeys: { alex: { "a.pdf": "OLD" } } } as unknown as Vault;

    expect(withKeys(before, "alex", { "b.pdf": "NEW" }).rawKeys?.alex).toEqual({ "a.pdf": "OLD", "b.pdf": "NEW" });
  });

  it("leaves another patient's ring untouched", () => {
    const before = { clients: {}, rawKeys: { sam: { "b.pdf": "OTHER" } } } as unknown as Vault;

    expect(withKeys(before, "alex", { "a.pdf": "K" }).rawKeys?.sam).toEqual({ "b.pdf": "OTHER" });
  });
});
