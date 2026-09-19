import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSidebarMode, saveSidebarMode, modeForSection } from "../../src/lib/sidebar-mode";
import { AI_SECTIONS, PATIENT_SECTIONS } from "../../src/lib/report-sections";

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

describe("sidebar-mode", () => {
  it("defaults to patient when nothing is stored", () => {
    expect(loadSidebarMode()).toBe("patient");
  });

  it("roundtrips investigator", () => {
    saveSidebarMode("investigator");
    expect(loadSidebarMode()).toBe("investigator");
  });

  it("roundtrips patient", () => {
    saveSidebarMode("patient");
    expect(loadSidebarMode()).toBe("patient");
  });
});

// M105 — modeForSection classifies a section key into the sidebar mode it belongs to (null for a
// key that's neither, e.g. "chat"), reused by both Sidebar.svelte's mode-sync effect and
// App.svelte's per-(role, client) location memory.
describe("modeForSection", () => {
  it("classifies every AI_SECTIONS key as investigator", () => {
    for (const s of AI_SECTIONS) expect(modeForSection(s.key)).toBe("investigator");
  });

  it("classifies every PATIENT_SECTIONS key as patient", () => {
    for (const s of PATIENT_SECTIONS) expect(modeForSection(s.key)).toBe("patient");
  });

  it("returns null for a key belonging to neither (e.g. chat, or no section at all)", () => {
    expect(modeForSection("chat")).toBeNull();
    expect(modeForSection(null)).toBeNull();
  });
});

// W46 — Search/Chat lead the sidebar (rendered ahead of PATIENT_SECTIONS in Sidebar.svelte), then
// Notes/Questions; pins the front of PATIENT_SECTIONS itself against a future reorder.
describe("PATIENT_SECTIONS order", () => {
  it("leads with Notes, Questions", () => {
    expect(PATIENT_SECTIONS.slice(0, 2).map((s) => s.key)).toEqual(["notes", "docInference"]);
  });

  // W48 — Profile (personalization) moved from last to right after Treatment, with Allergies/Family
  // immediately following it (Sidebar.svelte nests them under Profile's own lower zone; they stay
  // full PATIENT_SECTIONS members — see the comment on PATIENT_SECTION_ORDER — just not flat rows).
  // Allergies and Family render nested under Profile, so they must stay adjacent to it. Their
  // position relative to Treatment is not the invariant — Treatment now sits above Markers.
  it("keeps Profile, Allergies, Family consecutive", () => {
    const keys = PATIENT_SECTIONS.map((s) => s.key);
    const profileIdx = keys.indexOf("personalization");
    expect(keys.slice(profileIdx, profileIdx + 3)).toEqual(["personalization", "allergies", "familyHistory"]);
  });

  it("orders the flat rows Notes → Treatment → Markers → Reports", () => {
    const keys = PATIENT_SECTIONS.map((s) => s.key).filter((k) => !["docInference", "healthMarkers", "definitions", "allergies", "familyHistory"].includes(k));
    expect(keys.slice(0, 4)).toEqual(["notes", "treatment", "markers", "healthReports"]);
  });
});
