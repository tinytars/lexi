import { describe, it, expect } from "vitest";
import { ensureLeafIds } from "../../src/lib/leaf-ids";
import type { Client, DiseaseEntry, Vault } from "../../src/lib/types";

function vaultWith(client: Partial<Client>): Vault {
  return { clients: { p: { results: [], ...client } as Client } };
}

const dx = (id: string | undefined, diagnostic: string) =>
  ({ id, date: "2026-01-31", diagnostic, sourceId: "s1" }) as DiseaseEntry;

describe("ensureLeafIds", () => {
  // plover-factory#7: two id-less diagnoses on one report keyed ReportCell's {#each} as
  // undefined twice, and Svelte threw each_key_duplicate.
  it("mints an id for every leaf row that has none", () => {
    const v = ensureLeafIds(vaultWith({ factors: { diseases: [dx(undefined, "A"), dx(undefined, "B")] } }));
    const ids = v.clients.p.factors!.diseases!.map((d) => d.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-mints a duplicated id, keeping the first row's", () => {
    const v = ensureLeafIds(vaultWith({ factors: { diseases: [dx("x", "A"), dx("x", "B")] } }));
    const [a, b] = v.clients.p.factors!.diseases!;
    expect(a.id).toBe("x");
    expect(b.id).not.toBe("x");
  });

  it("leaves unique ids untouched", () => {
    const v = ensureLeafIds(vaultWith({ factors: { diseases: [dx("x", "A"), dx("y", "B")] } }));
    expect(v.clients.p.factors!.diseases!.map((d) => d.id)).toEqual(["x", "y"]);
  });

  it("covers every leaf list, study entries included", () => {
    const row = () => ({}) as never;
    const v = ensureLeafIds(vaultWith({
      factors: {
        treatments: [row(), row()], allergies: [row(), row()], familyHistory: [row(), row()],
        decisions: [row(), row()], noteEntries: [row(), row()],
      },
      study: { entries: [row(), row()] },
    }));
    const f = v.clients.p.factors!;
    for (const list of [f.treatments, f.allergies, f.familyHistory, f.decisions, f.noteEntries, v.clients.p.study!.entries]) {
      const ids = (list as { id: string }[]).map((r) => r.id);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(2);
    }
  });
});
