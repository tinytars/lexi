// Not session-gated: the signed, email-bound token IS the authorization (the link is usually opened in
// another browser), so its signature, window and current-address binding are the whole security model.

import { describe, it, expect } from "vitest";
import { onRequestGet as confirmEmail } from "../../functions/api/auth/email/confirm";
import { createAccount, getAccount } from "../../functions/_lib/identity-accounts";
import { signEmailToken } from "../../functions/_lib/email";
import { signValue } from "../../functions/_lib/session";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET } from "../support/session";

// Per test: accounts.email is UNIQUE and every test reuses the same addresses.
const w = useWorkerd({ perTest: true });

const env = () => ({ DB: w.db, SESSION_SECRET }) as any;
const confirm = (token: string | null) =>
  confirmEmail({
    request: new Request(`http://x/api/auth/email/confirm${token === null ? "" : `?token=${encodeURIComponent(token)}`}`),
    env: env(),
  });

async function account(email: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "A", email });
  return id;
}
const confirmedFlag = async (id: string) => (await getAccount(w.db, id))?.emailConfirmed;

describe("confirming an email address", () => {
  it("confirms the account the token names, and says so in the redirect", async () => {
    const id = await account("a@x.test");
    expect(await confirmedFlag(id)).toBeFalsy();

    const res = await confirm(await signEmailToken(env(), id, "a@x.test"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?email_verify=ok");
    expect(await confirmedFlag(id)).toBeTruthy();
  });

  it("is idempotent — a link clicked twice, or by a mail scanner and then a person, still reads ok", async () => {
    const id = await account("a@x.test");
    const token = await signEmailToken(env(), id, "a@x.test");
    await confirm(token);
    const second = await confirm(token);
    expect(second.headers.get("location")).toBe("/?email_verify=ok");
    expect(await confirmedFlag(id)).toBeTruthy();
  });

  it("rejects a token this deployment did not sign", async () => {
    const id = await account("a@x.test");
    const forged = await signValue("some-other-secret", { accountId: id, email: "a@x.test", purpose: "email-confirm" }, 3600);
    expect((await confirm(forged)).headers.get("location")).toBe("/?email_verify=invalid");
    expect(await confirmedFlag(id)).toBeFalsy();
  });

  it("rejects an EXPIRED token — the seven-day window is the point of having one", async () => {
    const id = await account("a@x.test");
    const stale = await signValue(SESSION_SECRET, { accountId: id, email: "a@x.test", purpose: "email-confirm" }, -1);
    expect((await confirm(stale)).headers.get("location")).toBe("/?email_verify=invalid");
    expect(await confirmedFlag(id)).toBeFalsy();
  });

  it("rejects a correctly-signed token minted for a DIFFERENT purpose", async () => {
    // A session cookie is signed with the same secret. Without the purpose check it would confirm.
    const id = await account("a@x.test");
    const wrongPurpose = await signValue(SESSION_SECRET, { accountId: id, email: "a@x.test", purpose: "session" }, 3600);
    expect((await confirm(wrongPurpose)).headers.get("location")).toBe("/?email_verify=invalid");
    expect(await confirmedFlag(id)).toBeFalsy();
  });

  it("rejects a link superseded by an email change, rather than confirming the NEW address", async () => {
    // A link mailed to the old address must not stamp the repointed one as verified.
    const id = await account("old@x.test");
    const token = await signEmailToken(env(), id, "old@x.test");
    await w.db.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind("attacker@x.test", id).run();

    expect((await confirm(token)).headers.get("location")).toBe("/?email_verify=invalid");
    expect(await confirmedFlag(id)).toBeFalsy();
  });

  it("rejects a token for an account that no longer exists", async () => {
    const token = await signEmailToken(env(), crypto.randomUUID(), "ghost@x.test");
    expect((await confirm(token)).headers.get("location")).toBe("/?email_verify=invalid");
  });

  it("rejects a missing or garbage token without throwing", async () => {
    expect((await confirm(null)).headers.get("location")).toBe("/?email_verify=invalid");
    expect((await confirm("not-a-token")).headers.get("location")).toBe("/?email_verify=invalid");
  });
});
