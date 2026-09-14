import { describe, it, expect } from "vitest";
import { stripConditions } from "../../scripts/conditions-strip";
import { nodeHashesOf } from "../../scripts/factors";
import type { Vault, Client } from "../../src/lib/types";

function vaultWith(factors: Record<string, unknown>, finding?: Record<string, unknown>): Vault {
  return {
    clients: {
      Test: {
        displayName: "Test",
        dob: "1980-01-01",
        gender: "male",
        watchlist: [],
        results: [],
        factors: factors as any,
        ...(finding ? { finding: finding as any } : {}),
      } as any,
    },
  };
}

describe("stripConditions", () => {
  it("deletes factors.conditions and reports it stripped", () => {
    const vault = vaultWith({ conditions: [{ id: "c1", text: "Fatigue" }] });

    const n = stripConditions(vault);

    expect(n).toBe(1);
    expect("conditions" in vault.clients.Test.factors!).toBe(false);
  });

  it("deletes finding.conditionResults and its nodeHashes entries", () => {
    const vault = vaultWith({}, {
      disease: [],
      treatment: [],
      conditionResults: [{ conditionId: "c1", result: "old" }],
      nodeHashes: { patientConditions: "abc", conditionResults: "def", markerLevels: "stale-placeholder" },
    });

    const n = stripConditions(vault);

    expect(n).toBe(1);
    const finding = vault.clients.Test.finding as any;
    expect("conditionResults" in finding).toBe(false);
    expect("patientConditions" in finding.nodeHashes).toBe(false);
    expect("conditionResults" in finding.nodeHashes).toBe(false);
  });

  // M-conditions-strip — removing factors.conditions changes patientAssessment's canonical input
  // string even when nothing about the patient's actual data changed, so the OLD stored nodeHashes
  // stamp (computed pre-strip) would read as stale post-strip and — via App.svelte's regenNode
  // ancestor-block guard — silently block every leaf-regen trigger downstream, not just
  // conditions-related ones. Re-stamping nodeHashes from the post-strip data keeps this a no-op.
  it("re-stamps finding.nodeHashes from the post-strip data so nothing reads as newly stale", () => {
    const vault = vaultWith(
      { conditions: [{ id: "c1", text: "Fatigue" }] },
      { disease: [], treatment: [], nodeHashes: { patientAssessment: "stale-from-before-strip" } },
    );

    stripConditions(vault);

    const client = vault.clients.Test as unknown as Client;
    expect(client.finding!.nodeHashes).toEqual(nodeHashesOf(client));
  });

  it("is a no-op and returns 0 for a client with neither field", () => {
    const vault = vaultWith({ diseases: [] }, { disease: [], treatment: [] });

    const n = stripConditions(vault);

    expect(n).toBe(0);
  });

  it("is idempotent: a second run finds nothing left to strip", () => {
    const vault = vaultWith({ conditions: [{ id: "c1", text: "Fatigue" }] }, { disease: [], treatment: [], conditionResults: [] });

    stripConditions(vault);
    const n = stripConditions(vault);

    expect(n).toBe(0);
  });
});
