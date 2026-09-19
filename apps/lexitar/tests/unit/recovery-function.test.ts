import { describe, it, expect } from "vitest";
import { onRequestPost as regen } from "../../functions/api/account/recovery";
import { onRequestGet as recSalt } from "../../functions/api/auth/recovery/salt";
import { onRequestPost as recLogin } from "../../functions/api/auth/recovery/login";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash, unwrapPrivateKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const ITER = 200_000;
const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET }) as any;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// Set a recovery code for an account via the (session-gated) regen endpoint — which stores the verifier.
async function setRecovery(accountId: string, privateKey: CryptoKey, code: string) {
  const salt = rand(16);
  const kek = await deriveKekFromPassword(code, salt);
  const wrapped = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(code, salt);
  const res = await regen({
    request: new Request("http://x/api/account/recovery", { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(accountId) }, body: JSON.stringify({ wrappedPrivateKey: b64(wrapped), kdfParams: { salt: hex(salt), iterations: ITER }, recoveryAuthHash: authHash }) }),
    env: makeEnv(),
  });
  expect(res.status).toBe(200);
}
async function recover(email: string, code: string) {
  const saltRes = await recSalt({ request: new Request(`http://x/api/auth/recovery/salt?email=${encodeURIComponent(email)}`), env: makeEnv() });
  if (saltRes.status !== 200) return { status: saltRes.status } as const;
  const { salt } = await saltRes.json() as { salt: string };
  const authHash = await deriveAuthHash(code, hexToBytes(salt));
  const res = await recLogin({ request: new Request("http://x/api/auth/recovery/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, recoveryAuthHash: authHash }) }), env: makeEnv() });
  return { status: res.status, res };
}

describe("account recovery redemption", () => {
  it("recovers with the correct code and the returned wrapped key unwraps to the account key", async () => {
    const email = `r-${crypto.randomUUID()}@x.test`;
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "R", email });
    const { privateKey, publicKeyJwk } = await generateAccountKeypair();
    await putPublicKey(w.db, { accountId: id, publicKeyJwk });
    await setRecovery(id, privateKey, "CODE-ALPHA-1");

    const out = await recover(email, "CODE-ALPHA-1");
    expect(out.status).toBe(200);
    const data = await out.res!.json() as { wrappedPrivateKey: string; kdfParams: { salt: string; authHashSha256?: string } };
    expect(data.kdfParams.authHashSha256).toBeUndefined(); // verifier never returned
    // the wrapped key unwraps with the code-derived KEK
    const kek = await deriveKekFromPassword("CODE-ALPHA-1", hexToBytes(data.kdfParams.salt));
    await expect(unwrapPrivateKey(Uint8Array.from(Buffer.from(data.wrappedPrivateKey, "base64")), kek)).resolves.toBeDefined();
    // and issues a session
    expect(out.res!.headers.get("set-cookie")).toContain("hd_session=");
  });

  it("rejects a wrong recovery code (401)", async () => {
    const email = `r-${crypto.randomUUID()}@x.test`;
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "R", email });
    const { privateKey, publicKeyJwk } = await generateAccountKeypair();
    await putPublicKey(w.db, { accountId: id, publicKeyJwk });
    await setRecovery(id, privateKey, "RIGHT-CODE");
    expect((await recover(email, "WRONG-CODE")).status).toBe(401);
  });

  it("regen replaces the code: the new code works, the old one 401s", async () => {
    const email = `r-${crypto.randomUUID()}@x.test`;
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "R", email });
    const { privateKey, publicKeyJwk } = await generateAccountKeypair();
    await putPublicKey(w.db, { accountId: id, publicKeyJwk });
    await setRecovery(id, privateKey, "OLD-CODE");
    await setRecovery(id, privateKey, "NEW-CODE"); // regen
    expect((await recover(email, "NEW-CODE")).status).toBe(200);
    expect((await recover(email, "OLD-CODE")).status).toBe(401);
  });

  // A 404 for unknown addresses would answer "is this person a patient here", unauthenticated.
  describe("the salt lookup does not reveal whether an account exists", () => {
    const saltFor = async (email: string) =>
      recSalt({ request: new Request(`http://x/api/auth/recovery/salt?email=${encodeURIComponent(email)}`), env: makeEnv() });

    it("answers a registered address and an unknown one indistinguishably", async () => {
      const registered = `r-${crypto.randomUUID()}@x.test`;
      const id = crypto.randomUUID();
      await createAccount(w.db, { id, displayName: "R", email: registered });
      const { privateKey, publicKeyJwk } = await generateAccountKeypair();
      await putPublicKey(w.db, { accountId: id, publicKeyJwk });
      await setRecovery(id, privateKey, "CODE");

      const real = await saltFor(registered);
      const decoy = await saltFor(`nobody-${crypto.randomUUID()}@x.test`);
      expect(decoy.status).toBe(real.status);

      const a = (await real.json()) as { salt: string; iterations: number };
      const b = (await decoy.json()) as { salt: string; iterations: number };
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(b.salt).toHaveLength(a.salt.length);
      expect(b.iterations).toBe(a.iterations);
    });

    // Stable, or probing twice tells the caller which one is fabricated — a real salt does not move.
    it("returns the same decoy every time for the same address", async () => {
      const unknown = `nobody-${crypto.randomUUID()}@x.test`;
      const first = (await (await saltFor(unknown)).json()) as { salt: string };
      const second = (await (await saltFor(unknown)).json()) as { salt: string };
      expect(second.salt).toBe(first.salt);
    });

    it("and a different one per address, so decoys are not recognisable as a constant", async () => {
      const one = (await (await saltFor(`a-${crypto.randomUUID()}@x.test`)).json()) as { salt: string };
      const two = (await (await saltFor(`b-${crypto.randomUUID()}@x.test`)).json()) as { salt: string };
      expect(two.salt).not.toBe(one.salt);
    });

    // The point is indistinguishability, not that a nonexistent account can be logged into.
    it("does not make the recovery that follows succeed", async () => {
      const unknown = `nobody-${crypto.randomUUID()}@x.test`;
      expect((await recover(unknown, "ANY-CODE")).status).toBe(401);
    });
  });
});
