import { describe, it, expect } from "vitest";
import { signEmailToken, verifyEmailToken, sendEmail } from "../../functions/_lib/email";
import { signValue } from "../../functions/_lib/session";

// W47 — the email-verification token is a signed, purpose- and email-bound value (same HMAC scheme as
// the session cookie). These assertions pin the security-relevant behavior: a good token round-trips,
// and anything that isn't a genuine email-confirm token is rejected.
const env = { SESSION_SECRET: "test-secret-000" };

describe("email verification token", () => {
  it("round-trips a valid token", async () => {
    const token = await signEmailToken(env, "acct-1", "a@b.com");
    const parsed = await verifyEmailToken(env, token);
    expect(parsed).toMatchObject({ accountId: "acct-1", email: "a@b.com", purpose: "email-confirm" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signEmailToken({ SESSION_SECRET: "other" }, "acct-1", "a@b.com");
    expect(await verifyEmailToken(env, token)).toBeNull();
  });

  it("rejects a signed value that isn't an email-confirm token (e.g. a session-shaped value)", async () => {
    const notEmail = await signValue(env.SESSION_SECRET, { accountId: "acct-1" }, 3600);
    expect(await verifyEmailToken(env, notEmail)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyEmailToken(env, "not.a.token")).toBeNull();
    expect(await verifyEmailToken(env, null)).toBeNull();
  });
});

describe("sendEmail without Gmail configured", () => {
  it("no-ops (does not throw) so the flow is testable in dev", async () => {
    const res = await sendEmail(env, { to: "a@b.com", subject: "hi", text: "body" });
    expect(res.sent).toBe(false);
  });
});
