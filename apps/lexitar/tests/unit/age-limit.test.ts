import { describe, it, expect } from "vitest";
import { MIN_AGE, DOB_REQUIRED_MESSAGE, UNDERAGE_MESSAGE, ageRefusal } from "../../src/lib/age-limit";

// 9C.3 — the gate is a claim in the Terms until this suite can fail. Boundaries are stated as
// offsets from the current year so the test does not expire, which is the usual way an age test
// quietly stops testing anything.
const year = new Date().getUTCFullYear();
const bornYearsAgo = (n: number) => `${year - n}-01-01`;

describe("the 16+ refusal", () => {
  it("admits someone who turns MIN_AGE this year", () => {
    expect(ageRefusal(bornYearsAgo(MIN_AGE))).toBeNull();
  });

  it("refuses someone a year short of it", () => {
    expect(ageRefusal(bornYearsAgo(MIN_AGE - 1))).toBe(UNDERAGE_MESSAGE);
  });

  it("admits an adult", () => {
    expect(ageRefusal(bornYearsAgo(40))).toBeNull();
  });

  it("refuses an empty dob — the Skip path, where there is no year to check", () => {
    expect(ageRefusal("")).toBe(DOB_REQUIRED_MESSAGE);
    expect(ageRefusal(undefined)).toBe(DOB_REQUIRED_MESSAGE);
  });

  it("refuses an unparseable dob rather than reading it as ancient", () => {
    expect(ageRefusal("not-a-date")).toBe(DOB_REQUIRED_MESSAGE);
  });
});
