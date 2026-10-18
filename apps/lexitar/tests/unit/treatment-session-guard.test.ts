import { describe, it, expect } from "vitest";
import { wasSavedThisSession } from "../../src/lib/treatment-session-guard";
import type { Client } from "../../src/lib/types";

function client(treatmentIds: string[]): Client {
  return {
    displayName: "Test",
    dob: "2000-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: { treatments: treatmentIds.map((id) => ({ id, name: "x", start: "2026-01-01" })) },
  };
}

describe("wasSavedThisSession", () => {
  it("is true when the id exists in the client's persisted treatments", () => {
    expect(wasSavedThisSession(client(["a", "b"]), "a")).toBe(true);
  });
  it("is false when the id is not in the client's persisted treatments (added this session, never saved)", () => {
    expect(wasSavedThisSession(client(["a", "b"]), "c")).toBe(false);
  });
  it("is false when the client has no factors at all", () => {
    const c: Client = { displayName: "Test", dob: "2000-01-01", gender: "male", watchlist: [], results: [] };
    expect(wasSavedThisSession(c, "a")).toBe(false);
  });
  it("is false when factors.treatments is undefined", () => {
    const c: Client = { displayName: "Test", dob: "2000-01-01", gender: "male", watchlist: [], results: [], factors: {} };
    expect(wasSavedThisSession(c, "a")).toBe(false);
  });
});
