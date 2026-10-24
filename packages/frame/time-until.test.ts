import { describe, it, expect } from "vitest";
import { daysUntil, shortDate, timeUntil } from "./time-until";

// A fixed `now` so every sentence below is the same on any day and in any week.
const NOW = Date.parse("2026-10-20T15:00:00Z");
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe("daysUntil", () => {
  it("counts whole days forward", () => expect(daysUntil(inDays(30), NOW)).toBe(30));
  it("goes negative once the date has passed", () => expect(daysUntil(inDays(-3), NOW)).toBe(-3));
  it("rounds a part-day to the day it is nearest", () => expect(daysUntil(inHours(29), NOW)).toBe(1));
  it("is NaN for a malformed date rather than a wrong number", () => expect(daysUntil("nope", NOW)).toBeNaN());
});

describe("shortDate", () => {
  it("leaves the year off when it is the current one", () => expect(shortDate(inDays(30), NOW, "en-GB")).toBe("19 Nov"));
  it("names the year when it is a different one", () => expect(shortDate(inDays(120), NOW, "en-GB")).toBe("17 Feb 2027"));
  it("says unknown rather than Invalid Date", () => expect(shortDate("nope", NOW)).toBe("unknown"));
});

describe("timeUntil", () => {
  // The reason this file exists: timeAgo answers "just now" for every one of these.
  it.each([
    [inDays(5), "in 5 days"],
    [inDays(1), "tomorrow"],
    [inHours(3), "in 3 hours"],
    [inHours(1), "in 1 hour"],
    [inDays(45), "in 2 months"],
    [inDays(400), "in 1 year"],
  ])("%s reads as %s", (iso, expected) => expect(timeUntil(iso, NOW)).toBe(expected));

  it("does not count down a date already past", () => expect(timeUntil(inDays(-1), NOW)).toBe("already passed"));
  it("says unknown for a malformed date", () => expect(timeUntil("nope", NOW)).toBe("unknown"));
});
