// W73 Phase E — the operator's last-resort path, and the one property that makes it worth having.
//
// `scripts/recovery-approve.ts` writes a `recovery_grants` row directly, using the org envelope rather
// than a clinician's. It is therefore the ONLY writer of that table other than `issueGrant`, and the
// two must agree exactly on how the verifier is derived.
//
// If they drift, the operator path mints codes that look right, print fine, and are rejected by the
// patient's screen — which is the worst way for a last-resort tool to fail, because it surfaces during
// a phone call with someone who is already locked out and has no other route left. So the test is not
// "does it produce a row", it is "does the ROUTE accept the row it produces".
//
// The CLI's own shell-out to wrangler is not exercised here: it talks to a remote D1 by design, and
// mocking that would test the mock. What is exercised is everything the shell-out carries.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { checkRedemption } from "../../functions/_lib/recovery";
import { buildGrantRow, randomCode } from "../../scripts/recovery-approve";
import { generateDEK, deriveAuthHash, encryptVaultV2, decryptVaultV2, unwrapDEKWithKek, deriveKekFromPassword } from "@tinytars/vault/crypto";

let mf: Miniflare;
let db: any;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-approve-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const ORG = "00000000-0000-4000-8000-000000000001";

// The org account has to exist for `issued_by` to satisfy its foreign key — which is the constraint
// working: a grant must always name a real principal that issued it, or the audit trail is a fiction.
async function seedOrg() {
  await createAccount(db, { id: ORG, displayName: "Org" });
}

/** Writes the row exactly as the CLI's INSERT does, so the shapes are compared and not assumed. */
async function insertAsOperator(accountId: string, row: Awaited<ReturnType<typeof buildGrantRow>>) {
  const now = new Date();
  await db
    .prepare(
      "INSERT INTO recovery_grants (id, account_id, wrapped_dek, kdf_params, code_verifier_sha256, issued_by, issued_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
    )
    .bind(
      crypto.randomUUID(), accountId, row.wrappedDek, JSON.stringify(row.kdfParams), row.verifier,
      ORG, now.toISOString(), new Date(now.getTime() + 3600_000).toISOString(),
    )
    .run();
}

async function account() {
  await seedOrg();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "P", email: `${id}@example.com` });
  return id;
}

describe("a grant written by the operator CLI is redeemable by the route", () => {
  it("is accepted by checkRedemption with the right code", async () => {
    // The whole point of Phase E: no operator-only redemption path exists, so the patient uses the
    // same screen either way.
    const id = await account();
    const code = randomCode();
    const row = await buildGrantRow(await generateDEK(), code);
    await insertAsOperator(id, row);

    const proof = await deriveAuthHash(code.replace(/-/g, ""), hexToBytes(row.kdfParams.salt));
    expect(await checkRedemption(db, id, proof)).toMatchObject({ ok: true });
  });

  it("is rejected with a wrong code, and still counts the attempt", async () => {
    const id = await account();
    const row = await buildGrantRow(await generateDEK(), randomCode());
    await insertAsOperator(id, row);

    const wrong = await deriveAuthHash("WRONGWRONG12", hexToBytes(row.kdfParams.salt));
    expect(await checkRedemption(db, id, wrong)).toMatchObject({ ok: false, errorCode: "invalid_code" });
    const after = await db.prepare("SELECT attempts FROM recovery_grants WHERE account_id = ?").bind(id).first();
    expect(after.attempts).toBe(1);
  });

  it("hands back a DEK that actually opens the vault", async () => {
    // Not just "the verifier matched". The blob has to unwrap to the same key, or a patient completes
    // the whole flow and finds an unreadable record.
    const dek = await generateDEK();
    const blob = await encryptVaultV2({ clients: { a: 1 } } as never, dek);
    const code = randomCode();
    const row = await buildGrantRow(dek, code);

    const back = await unwrapDEKWithKek(row.wrappedDek, await deriveKekFromPassword(code.replace(/-/g, ""), hexToBytes(row.kdfParams.salt)));
    expect(await decryptVaultV2(blob, back)).toEqual({ clients: { a: 1 } });
  });
});

describe("the code the operator reads out", () => {
  it("is grouped for reading aloud and normalises back to 12 characters", () => {
    const code = randomCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code.replace(/-/g, "")).toHaveLength(12);
  });

  it("excludes the characters that are misheard down a phone line", () => {
    // I/L/O/U are absent by construction: this code's whole delivery mechanism is someone saying it
    // aloud, so "I or 1" and "O or 0" are not academic.
    const codes = Array.from({ length: 200 }, () => randomCode().replace(/-/g, "")).join("");
    for (const c of ["I", "L", "O", "U"]) expect(codes).not.toContain(c);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => randomCode()));
    expect(seen.size).toBe(500);
  });

  it("uses the same alphabet the browser mints, so the two are indistinguishable to a patient", async () => {
    const { randomGrantCode } = await import("@tinytars/vault/auth-recovery");
    const browser = Array.from({ length: 100 }, () => randomGrantCode().replace(/-/g, "")).join("");
    const cli = Array.from({ length: 100 }, () => randomCode().replace(/-/g, "")).join("");
    expect(new Set(cli.split("")).size).toBeGreaterThan(20);
    for (const ch of new Set(cli.split(""))) expect(browser).toContain(ch);
  });
});
