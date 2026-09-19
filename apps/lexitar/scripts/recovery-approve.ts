// W73 Phase E — the last rung of the recovery ladder: an operator issues a recovery code using the ORG
// envelope, for a patient with no recovery code and no clinician.
//
// Until this existed, RECOVERY.md's "an operator can help" was fiction. `scripts/org-key.ts` gave
// `loadOrgPrivateKey()` and nothing that turned it into something a locked-out patient could use, so
// the documented fallback was a sentence with no code behind it.
//
// WHAT MAKES THIS SAFE TO EXIST. It is a CLI, run by a person holding `ORG_KEY_PASSPHRASE`, and
// `tests/unit/recovery-invariants.test.ts` (I1) asserts that nothing under `functions/` can reach that
// key. A route that could do this would mean the operator can decrypt any vault on request, which is
// exactly the claim SECURITY.md makes and this milestone spent Phase D refusing to weaken.
//
// WHAT IT DELIBERATELY REUSES. It writes the same `recovery_grants` row a clinician writes, so the
// patient's side is byte-for-byte the flow they would use anyway: same screen, same code shape, same
// attempt cap, same expiry, same one-time use. There is no operator-only redemption path to get wrong,
// and no second thing to keep in sync.
//
//   ORG_KEY_PASSPHRASE=… npm run recovery:approve -- --email patient@example.com
//   ORG_KEY_PASSPHRASE=… npm run recovery:approve -- --email patient@example.com --confirm

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadOrgPrivateKey } from "./org-key";
import { wranglerTarget } from "./target";
import {
  unwrapDEKWithPrivateKey, wrapDEKWithKek, deriveKekFromPassword, deriveAuthHash,
} from "@tinytars/vault/crypto";
import { ORG_ACCOUNT_ID } from "../functions/_lib/org";
import { sha256Base64Url } from "../functions/_lib/verifier";
import { isMain } from "./is-main";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const WRANGLER = resolve(here, "wrangler.sh");
const D1 = wranglerTarget().database;

const GRANT_TTL_MS = 60 * 60 * 1000;
const KDF_ITERATIONS = 200_000;
/** Same alphabet as the browser mints (auth-client.ts): Crockford base32 minus I/L/O/U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

async function d1<T>(sql: string, params: string[] = []): Promise<T[]> {
  const args = ["d1", "execute", D1, "--remote", "--json", "--command", sql];
  // wrangler's --command takes no bind parameters, so values are inlined. Every value this script
  // inlines is either a UUID it generated or one it just read back out of this same database — never
  // operator input, which is the only reason that is acceptable here.
  for (const p of params) if (/[';\\]/.test(p)) throw new Error(`refusing to inline a value containing a quote: ${p}`);
  const { stdout } = await execFileAsync("bash", [WRANGLER, ...args], { cwd: APP, maxBuffer: 64 * 1024 * 1024 });
  return (JSON.parse(stdout) as Array<{ results: T[] }>)[0].results;
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function randomCode(): string {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/**
 * The columns of a `recovery_grants` row, built from a DEK and a code.
 *
 * Exported and tested against `checkRedemption` for one reason: this is the ONLY place a grant is
 * written by something other than `issueGrant`, and the two must agree on the verifier's exact shape.
 * If they drift, the operator path mints codes that look right, print fine, and are rejected by the
 * patient's screen — the worst possible failure for a last-resort tool, because it surfaces on a phone
 * call with someone who is already locked out.
 *
 * It calls the same `sha256Base64Url` the route calls, rather than hand-rolling a digest here.
 */
export async function buildGrantRow(dek: CryptoKey, code: string): Promise<{
  wrappedDek: Uint8Array;
  kdfParams: { salt: string; iterations: number };
  verifier: string;
}> {
  const normalized = code.replace(/-/g, "");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    wrappedDek: await wrapDEKWithKek(dek, await deriveKekFromPassword(normalized, salt)),
    kdfParams: { salt: hex(salt), iterations: KDF_ITERATIONS },
    verifier: await sha256Base64Url(await deriveAuthHash(normalized, salt)),
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = flag("email");
  if (!email) {
    process.stderr.write("usage: recovery:approve -- --email <patient email> [--confirm]\n");
    process.exit(2);
  }
  const confirm = process.argv.includes("--confirm");

  const [acct] = await d1<{ id: string; email: string; display_name: string; deleted_at: string | null }>(
    `SELECT id, email, display_name, deleted_at FROM accounts WHERE email = ${q(email)}`,
  );
  if (!acct) throw new Error(`no account with email ${email}`);
  if (acct.deleted_at) throw new Error(`that account was erased on ${acct.deleted_at}`);

  const [vault] = await d1<{ vault_id: string; org_recovery_revoked_at: string | null }>(
    `SELECT vault_id, org_recovery_revoked_at FROM vaults WHERE owner_account_id = ${q(acct.id)}`,
  );
  if (!vault) throw new Error("that account has no vault");

  // The patient's opt-out, and it is absolute. Revoking org recovery is the one lever a patient has to
  // say "not even the operator", and honouring it is the entire value of offering it. If this ever
  // becomes a --force flag, the checkbox in the UI has been lying.
  if (vault.org_recovery_revoked_at) {
    throw new Error(
      `this patient revoked org recovery on ${vault.org_recovery_revoked_at}. Their record cannot be opened by anyone, including us. That is the setting working correctly.`,
    );
  }

  const [envelope] = await d1<{ wrapped_dek: string; ephemeral_public_key_jwk: string }>(
    `SELECT hex(wrapped_dek) AS wrapped_dek, ephemeral_public_key_jwk FROM vault_envelopes WHERE vault_id = ${q(vault.vault_id)} AND principal_account_id = ${q(ORG_ACCOUNT_ID)}`,
  );
  if (!envelope) throw new Error("no org recovery envelope for that vault — nothing here can open it");

  process.stdout.write(`\nAccount : ${acct.display_name} <${acct.email}>\nVault   : ${vault.vault_id}\nTarget  : ${D1}\n\n`);
  if (!confirm) {
    process.stdout.write(
      "This will issue a one-time recovery code that resets the account: the patient's current\n" +
      "password, passkey and Google sign-in all stop working, and every session is revoked.\n\n" +
      "Verify who you are talking to FIRST — call the number you already hold for them. Then re-run\n" +
      "with --confirm.\n\n",
    );
    return;
  }

  // The only place the org private key is used. It never leaves this process.
  const orgKey = await loadOrgPrivateKey();
  const dek = await unwrapDEKWithPrivateKey(
    Uint8Array.from(Buffer.from(envelope.wrapped_dek, "hex")),
    JSON.parse(envelope.ephemeral_public_key_jwk) as JsonWebKey,
    orgKey,
  );

  const code = randomCode();
  const { wrappedDek, kdfParams, verifier } = await buildGrantRow(dek, code);

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();

  // Supersede any live grant first, destroying its blob — the same rule issueGrant() applies, and the
  // partial unique index would refuse the insert otherwise.
  await d1(`UPDATE recovery_grants SET consumed_at = ${q(now.toISOString())}, wrapped_dek = NULL WHERE account_id = ${q(acct.id)} AND consumed_at IS NULL`);
  await d1(
    `INSERT INTO recovery_grants (id, account_id, wrapped_dek, kdf_params, code_verifier_sha256, issued_by, issued_at, expires_at, attempts, consumed_at) ` +
    `VALUES (${q(id)}, ${q(acct.id)}, X'${hex(wrappedDek)}', ${q(JSON.stringify(kdfParams))}, ${q(verifier)}, ${q(ORG_ACCOUNT_ID)}, ${q(now.toISOString())}, ${q(expiresAt)}, 0, NULL)`,
  );
  // issued_by is the ORG account, so the patient's own access-events screen shows plainly that the
  // operator did this — not a clinician, and not themselves.
  await d1(
    `INSERT INTO phi_access_events (id, actor_account_id, subject_account_id, vault_id, action, consent_ref, meta, created_at) ` +
    `VALUES (${q(crypto.randomUUID())}, ${q(ORG_ACCOUNT_ID)}, ${q(acct.id)}, ${q(vault.vault_id)}, 'recovery.grant_issued_by_operator', ${q(id)}, ${q(JSON.stringify({ via: "org-envelope" }))}, ${q(now.toISOString())})`,
  );

  process.stdout.write(
    `Recovery code: ${code}\n\n` +
    `Read it to them. It works once and expires at ${expiresAt}.\n` +
    `They enter it at "Forgot password?" and choose a new password — one field, no toggle to pick.\n\n` +
    `It is not stored anywhere and will not be shown again. If it goes astray, run this again.\n`,
  );
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}
