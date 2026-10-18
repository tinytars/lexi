import { describe, it, expect } from "vitest";
import { patientSwitchedMidRequest } from "../../src/lib/stale-guard";

describe("patientSwitchedMidRequest", () => {
  it("is false when the current value is the same reference as the captured one", () => {
    const c = { id: "blair" };
    expect(patientSwitchedMidRequest(c, c)).toBe(false);
  });

  it("is true when the current value is a different reference, even with equal contents", () => {
    const captured = { id: "blair" };
    const current = { id: "blair" };
    expect(patientSwitchedMidRequest(current, captured)).toBe(true);
  });

  it("is true when the current value is null (patient closed mid-request)", () => {
    const captured = { id: "blair" };
    expect(patientSwitchedMidRequest(null, captured)).toBe(true);
  });

  it("is true when the current value is a genuinely different patient", () => {
    const captured = { id: "blair" };
    const current = { id: "ana" };
    expect(patientSwitchedMidRequest(current, captured)).toBe(true);
  });
});
