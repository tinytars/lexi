import { describe, it, expect } from "vitest";
import { shouldResyncDraft } from "../../src/lib/client-resync";
import type { Client } from "../../src/lib/types";

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    displayName: "Test",
    dob: "2000-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    ...overrides,
  };
}

describe("shouldResyncDraft", () => {
  it("returns true when prev is null", () => {
    expect(shouldResyncDraft(null, makeClient())).toBe(true);
  });

  it("returns false when only finding differs", () => {
    const prev = makeClient({ finding: { disease: [] } as any });
    const next = { ...prev, finding: { disease: [{}] } as any };
    expect(shouldResyncDraft(prev, next)).toBe(false);
  });

  it("returns true when study differs", () => {
    const prev = makeClient({ study: { entries: [] } as any });
    const next = { ...prev, study: { entries: [{}] } as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true when factors differs", () => {
    const prev = makeClient({ factors: { medications: [] } as any });
    const next = { ...prev, factors: { medications: [{}] } as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true when sources differs alone", () => {
    const prev = makeClient({ sources: [] });
    const next = { ...prev, sources: [{}] as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true when results differs alone", () => {
    const prev = makeClient({ results: [] });
    const next = { ...prev, results: [{}] as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true when removedSources differs alone", () => {
    const prev = makeClient({ removedSources: [] });
    const next = { ...prev, removedSources: [{}] as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true when pendingUploads differs alone", () => {
    const prev = makeClient({ pendingUploads: [] });
    const next = { ...prev, pendingUploads: [{}] as any };
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });

  it("returns true for a totally different client (patient switch)", () => {
    const prev = makeClient({ displayName: "Alex" });
    const next = makeClient({ displayName: "Blair" });
    expect(shouldResyncDraft(prev, next)).toBe(true);
  });
});
