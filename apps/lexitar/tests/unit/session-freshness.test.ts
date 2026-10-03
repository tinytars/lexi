// The gate that replaces a password challenge on the route that converts read access into account
// control. It is a pure function of the cookie's `iat` precisely so it can be tested without a browser:
// the account it exists to protect signs in with Google and a passkey, and neither can be driven here.
import { describe, it, expect } from "vitest";
import { requireFreshSession, FRESH_SESSION_SECONDS } from "../../functions/_lib/step-up";

const now = new Date("2026-09-27T12:00:00Z");
const mintedAgo = (seconds: number) => Math.floor(now.getTime() / 1000) - seconds;

describe("requireFreshSession", () => {
  it("accepts a cookie minted moments ago", () => {
    expect(requireFreshSession(mintedAgo(0), now)).toEqual({ ok: true, ageSeconds: 0 });
    expect(requireFreshSession(mintedAgo(30), now)).toEqual({ ok: true, ageSeconds: 30 });
  });

  it("accepts the last second of the window and refuses the next one", () => {
    // The boundary is the whole behaviour: an off-by-one here is either a gate that expires early on a
    // slow sign-in or one that keeps honouring a cookie past the margin it claims.
    expect(requireFreshSession(mintedAgo(FRESH_SESSION_SECONDS), now).ok).toBe(true);
    expect(requireFreshSession(mintedAgo(FRESH_SESSION_SECONDS + 1), now).ok).toBe(false);
  });

  it("refuses a thirty-day-old cookie and reports its real age", () => {
    // The age is what the audit row carries, so it has to be the true age rather than a capped one.
    const month = 60 * 60 * 24 * 30;
    expect(requireFreshSession(mintedAgo(month), now)).toEqual({ ok: false, ageSeconds: month });
  });

  it("refuses a cookie dated in the future rather than reading it as brand new", () => {
    // Clock skew between the signer and this isolate, not freshness. Clamping a negative age to 0 would
    // make a cookie dated tomorrow pass for a day.
    expect(requireFreshSession(mintedAgo(-60), now)).toEqual({ ok: false, ageSeconds: -60 });
  });
});
