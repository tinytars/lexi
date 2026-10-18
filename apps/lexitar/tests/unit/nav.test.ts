import { describe, it, expect } from "vitest";
import { TABS, DEFAULT_TAB, isTab } from "../../src/lib/nav";

describe("nav", () => {
  it("has the experiences in order: Labs right of Chat, Appointment right of Patient, Investigator last (the doctor tab id is unchanged; W37 relabeled it Profile→Patient and moved the profile editor to its first subsection; M62 pulled Markers/Reports out to Labs and Questions/Glossary out to Appointment; Import/Export are header buttons, not tabs; M84 relabeled the chat tab Assistant→Chat)", () => {
    expect(TABS.map((t) => t.id)).toEqual(["chat", "labs", "doctor", "appointment", "ai"]);
  });

  it("labels the doctor tab Patient (W37) and every tab carries a blurb", () => {
    expect(TABS.find((t) => t.id === "doctor")?.label).toBe("Patient");
    for (const t of TABS) expect(t.blurb.length).toBeGreaterThan(0);
  });

  it("lands on Chat by default", () => {
    expect(DEFAULT_TAB).toBe("chat");
  });

  it("isTab validates known ids", () => {
    expect(isTab("doctor")).toBe(true);
    expect(isTab("bogus")).toBe(false);
  });
});
