import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadLastSection, saveLastSection, loadLastGroup, saveLastGroup } from "../../src/lib/nav-memory";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", fakeStorage);
});

describe("last section (per client, per mode)", () => {
  it("returns null when nothing is remembered, or clientId/mode is missing", () => {
    expect(loadLastSection("alice", "patient")).toBeNull();
    expect(loadLastSection(null, "patient")).toBeNull();
    expect(loadLastSection("alice", null)).toBeNull();
  });

  it("roundtrips a section for a (client, mode) pair", () => {
    saveLastSection("alice", "patient", "conditions");
    expect(loadLastSection("alice", "patient")).toBe("conditions");
  });

  it("keeps patient and investigator memory independent for the same client", () => {
    saveLastSection("alice", "patient", "conditions");
    saveLastSection("alice", "investigator", "exploration");
    expect(loadLastSection("alice", "patient")).toBe("conditions");
    expect(loadLastSection("alice", "investigator")).toBe("exploration");
  });

  it("keeps memory independent across clients", () => {
    saveLastSection("alice", "patient", "conditions");
    saveLastSection("bob", "patient", "treatment");
    expect(loadLastSection("alice", "patient")).toBe("conditions");
    expect(loadLastSection("bob", "patient")).toBe("treatment");
  });
});

describe("last group (per client, per section)", () => {
  it("returns null when nothing is remembered, or clientId/section is missing", () => {
    expect(loadLastGroup("alice", "conditions")).toBeNull();
    expect(loadLastGroup(null, "conditions")).toBeNull();
    expect(loadLastGroup("alice", null)).toBeNull();
  });

  it("keeps a group remembered per section, independent of other sections visited since", () => {
    saveLastGroup("alice", "conditions", "system:renal");
    saveLastGroup("alice", "markers", "system:cardiovascular");
    expect(loadLastGroup("alice", "conditions")).toBe("system:renal");
    expect(loadLastGroup("alice", "markers")).toBe("system:cardiovascular");
  });

  it("keeps memory independent across clients", () => {
    saveLastGroup("alice", "conditions", "system:renal");
    saveLastGroup("bob", "conditions", "system:gastrointestinal");
    expect(loadLastGroup("alice", "conditions")).toBe("system:renal");
    expect(loadLastGroup("bob", "conditions")).toBe("system:gastrointestinal");
  });
});
