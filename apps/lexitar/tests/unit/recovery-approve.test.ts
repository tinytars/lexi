// The operator CLI and issueGrant must derive the verifier identically, so the ROUTE is what judges the CLI's row.
// The CLI's wrangler shell-out is not exercised: it talks to a remote D1 by design.
import { describe, it, expect, beforeAll } from "vitest";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { checkRedemption } from "../../functions/_lib/recovery";
import { buildGrantRow, randomCode } from "../../scripts/recovery-approve";
import { generateDEK, deriveAuthHash, encryptVaultV2, decryptVaultV2, unwrapDEKWithKek, deriveKekFromPassword } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";

const w = useWorkerd();
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const ORG = "00000000-0000-4000-8000-000000000001";

// `issued_by` is a foreign key: a grant must name a real principal that issued it.
beforeAll(async () => {
  await createAccount(w.db, { id: ORG, displayName: "Org" });
});

/** Writes the row exactly as the CLI's INSERT does, so the shapes are compared and not assumed. */
async function insertAsOperator(accountId: string, row: Awaited<ReturnType<typeof buildGrantRow>>) {
  const now = new Date();
  await w.db
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
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "P", email: `${id}@example.com` });
  return id;
}

describe("a grant written by the operator CLI is redeemable by the route", () => {
  it("is accepted by checkRedemption with the right code", async () => {
    // No operator-only redemption path exists, so the patient uses the same screen either way.
    const id = await account();
    const code = randomCode();
    const row = await buildGrantRow(await generateDEK(), code);
    await insertAsOperator(id, row);

    const proof = await deriveAuthHash(code.replace(/-/g, ""), hexToBytes(row.kdfParams.salt));
    expect(await checkRedemption(w.db, id, proof)).toMatchObject({ ok: true });
  });

  it("is rejected with a wrong code, and still counts the attempt", async () => {
    const id = await account();
    const row = await buildGrantRow(await generateDEK(), randomCode());
    await insertAsOperator(id, row);

    const wrong = await deriveAuthHash("WRONGWRONG12", hexToBytes(row.kdfParams.salt));
    expect(await checkRedemption(w.db, id, wrong)).toMatchObject({ ok: false, errorCode: "invalid_code" });
    const after = await w.db.prepare("SELECT attempts FROM recovery_grants WHERE account_id = ?").bind(id).first<{ attempts: number }>();
    expect(after!.attempts).toBe(1);
  });

  it("hands back a DEK that actually opens the vault", async () => {
    // Not just "the verifier matched": a wrong key would complete the flow onto an unreadable record.
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
