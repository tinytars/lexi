// The principal whose password sits in the credentials repository for a week at a time, and the
// properties that make putting it there acceptable. Everything here is applied from the SQL
// `provision-support-account.ts` actually emits — a hand-built stand-in would pin the shape this file
// believes the script produces rather than the shape it does.
//
// What is deliberately NOT re-asserted here: that a support principal is refused
// `PUT /api/vault/{id}`. That gate keys on the account's ROLE, this file pins the role the script
// writes, and tests/unit/vault-put-principal.test.ts pins the refusal for that role — restating it
// would be one claim in two places, which is how one of them becomes a lie.
import { describe, it, expect, beforeAll } from "vitest";
import { getAccountByEmail } from "../../functions/_lib/identity-accounts";
import { listVaultsForOwner } from "../../functions/_lib/identity-vault";
import { can, roleOf } from "../../functions/_lib/capabilities";
import { onRequestPost as login } from "../../functions/api/auth/password/login";
import { onRequestGet as salt } from "../../functions/api/auth/password/salt";
import { onRequestPost as issueRecovery } from "../../functions/api/recovery/grant";
import { supportAccountSql } from "../../scripts/provision-support-account";
import { deriveAuthHash } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const w = useWorkerd();
const env = () => ({ DB: w.db, SESSION_SECRET }) as any;

const EMAIL = "record-cli@local.invalid";
const PASSWORD = "provisioned-not-a-real-secret";

let accountId: string;
let statements: string[];

beforeAll(async () => {
  const out = await supportAccountSql({ email: EMAIL, password: PASSWORD, displayName: "Record Export CLI" });
  accountId = out.accountId;
  statements = out.statements;
  for (const s of statements) await w.db.prepare(s).run();
});

describe("the provisioned support principal", () => {
  it("is a support account that owns no record", async () => {
    const acct = await getAccountByEmail(w.db, EMAIL);
    expect(acct?.providerKind).toBe("support");
    // No vault, and therefore nothing of its own to leak: the client treats a vaulted account as an
    // owner, and every record this principal ever opens is opened through somebody's grant.
    expect(await listVaultsForOwner(w.db, accountId)).toEqual([]);
  });

  it("emits no vault or envelope row at all, so it cannot be provisioned into owning one", () => {
    // The assertion above proves the database ended up that way; this one proves the script never tries,
    // which is what stops a later "while we're here, give it a vault" from passing the first test.
    expect(statements.some((s) => /INSERT INTO (vaults|vault_envelopes)/.test(s))).toBe(false);
  });

  it("signs in with the provisioned password and is handed no record", async () => {
    // The whole point of the credential in plover-keys: unattended sign-in works. And it hands back
    // nothing — `ownerEnvelope` null is the "on its own this password opens nothing" claim, measured.
    const s = await salt({ request: new Request(`http://x/api/auth/password/salt?email=${encodeURIComponent(EMAIL)}`), env: env() } as any);
    const { salt: saltHex, iterations } = (await s.json()) as { salt: string; iterations: number };
    const authHash = await deriveAuthHash(PASSWORD, Buffer.from(saltHex, "hex"));
    const res = await login({
      request: new Request("http://x/api/auth/password/login", { method: "POST", body: JSON.stringify({ email: EMAIL, authHash }) }),
      env: env(),
    } as any);
    expect(res.status).toBe(200);
    expect(iterations).toBe(200_000);
    const body = (await res.json()) as { accountId: string; vaultId: string | null; ownerEnvelope: unknown };
    expect(body.accountId).toBe(accountId);
    expect(body.vaultId).toBeNull();
    expect(body.ownerEnvelope).toBeNull();
  });

  it("holds no capability to issue account recovery", async () => {
    const acct = await getAccountByEmail(w.db, EMAIL);
    expect(can(roleOf(acct), "recovery:issue")).toBe(false);
  });

  it("is refused by POST /api/recovery/grant with a cookie minted a moment ago", async () => {
    // A FRESH cookie on purpose: the freshness gate would refuse a stale one for a reason that has
    // nothing to do with this principal, and would hide a capability check that had stopped working.
    const res = await issueRecovery({
      request: new Request("http://x/api/recovery/grant", {
        method: "POST",
        headers: { cookie: await cookieFor(accountId) },
        body: JSON.stringify({ ownerAccountId: crypto.randomUUID(), wrappedDek: "AA", kdfParams: { salt: "00", iterations: 200_000 }, codeAuthHash: "x" }),
      }),
      env: env(),
    } as any);
    expect(res.status).toBe(403);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("not_permitted");
  });
});
