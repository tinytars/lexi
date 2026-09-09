import { describe, it, expect } from "vitest";
import { timeAgo } from "../../src/lib/time-ago";

describe("timeAgo", () => {
  const NOW = new Date("2026-07-05T12:00:00Z").getTime();
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;

  it("collapses the last few seconds to 'just now'", () => {
    expect(timeAgo(ago(5 * s), NOW)).toBe("just now");
    expect(timeAgo(ago(44 * s), NOW)).toBe("just now");
  });

  it("reports minutes, hours, and days with correct pluralization", () => {
    expect(timeAgo(ago(1 * m), NOW)).toBe("1 minute ago");
    expect(timeAgo(ago(5 * m), NOW)).toBe("5 minutes ago");
    expect(timeAgo(ago(1 * h), NOW)).toBe("1 hour ago");
    expect(timeAgo(ago(3 * h), NOW)).toBe("3 hours ago");
    expect(timeAgo(ago(1 * d), NOW)).toBe("1 day ago");
    expect(timeAgo(ago(2 * d), NOW)).toBe("2 days ago");
  });

  it("rolls up to months and years for older timestamps", () => {
    expect(timeAgo(ago(45 * d), NOW)).toBe("2 months ago");
    expect(timeAgo(ago(400 * d), NOW)).toBe("1 year ago");
  });

  it("degrades a future or malformed timestamp instead of throwing", () => {
    expect(timeAgo(ago(-1 * h), NOW)).toBe("just now"); // clock skew → future
    expect(timeAgo("not-a-date", NOW)).toBe("unknown");
  });
});
