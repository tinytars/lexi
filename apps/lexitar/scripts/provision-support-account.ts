// W44 P4b — provision a support agent account in remote D1 (out-of-band; no self-service signup exists
// for provider_kind='support', and support must NOT own a vault — the client treats a vaulted account as
// an owner). Computes the crypto locally and emits a SQL file to apply with wrangler d1 execute --remote.
// A support account = accounts(provider_kind='support') + a password credential (wrapped key + verifier)
// + public_key + identity(password). NO vault.
//
//   EMAIL=support@local.invalid PASSWORD=support DISPLAY_NAME="Support Agent" \
//     NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npm run --silent support:provision > /tmp/support.sql
//
// `--silent` is not optional: npm writes its own two-line banner to stdout, which lands in the SQL file
// and makes wrangler reject the first statement.
//   npm run wrangler -- d1 execute health-identity-dev --remote --file /tmp/support.sql
//
// Where the password is kept depends on what the principal is for. The fam4 pilot's is documented in
// AUTH.md; the record-export CLI's is LEXITAR_SUPPORT_PASSWORD in plover-keys, which is acceptable only
// because this principal owns no record — VAULT.md §4a and scripts/api-session.ts's header state why.

import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash } from "@tinytars/vault/crypto";
import { isMain } from "./is-main";

export interface SupportAccountSpec {
  email: string;
  password: string;
  displayName: string;
  /** A fixed id makes a re-provision idempotent; omitted, one is generated. */
  accountId?: string;
  /** See the RESET warning in `supportAccountSql`. Never true against a database holding real links. */
  reset?: boolean;
}

const ITER = 200_000;

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
async function sha256Base64Url(s: string): Promise<string> {
  const d = new Uint8Array(await (globalThis.crypto as Crypto).subtle.digest("SHA-256", enc.encode(s)));
  return Buffer.from(d).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const sql = (s: string) => "'" + s.replace(/'/g, "''") + "'";

/**
 * The rows that make a support principal, as SQL. Exported rather than inlined into `main` so
 * tests/unit/support-principal.test.ts can apply exactly what a real provision applies: the claim the
 * seven-day credential rests on is about the principal THIS produces, not about a hand-built stand-in.
 */
export async function supportAccountSql(spec: SupportAccountSpec): Promise<{ accountId: string; statements: string[] }> {
  const now = "2026-07-07T00:00:00Z";
  const accountId = spec.accountId ?? crypto.randomUUID();
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();

  const salt = rand(16);
  const kek = await deriveKekFromPassword(spec.password, salt);
  const wrapped = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(spec.password, salt);
  const kdfParams = { salt: toHex(salt), iterations: ITER, authHashSha256: await sha256Base64Url(authHash) };

  const statements: string[] = [];
  if (spec.reset) {
    // Idempotent re-provision, for e2e only. NOT for a database holding real links: it orphans nothing
    // because it deletes provider_links outright — every grant a patient approved for this principal
    // disappears with no record that it existed — and it deletes phi_access_events rows, which the
    // audit work of this milestone makes strictly more destructive. Those rows are a patient's evidence
    // of who read their record and are deliberately kept even by account erasure
    // (functions/_lib/erasure.ts). A re-provision that needs the same id should pass `accountId`.
    const byEmail = `(SELECT id FROM accounts WHERE email = ${sql(spec.email)})`;
    statements.push(
      `DELETE FROM credentials WHERE account_id IN ${byEmail};`,
      `DELETE FROM identities WHERE account_id IN ${byEmail};`,
      `DELETE FROM public_keys WHERE account_id IN ${byEmail};`,
      `DELETE FROM provider_links WHERE provider_account_id IN ${byEmail} OR patient_account_id IN ${byEmail};`,
      // rows the support account accrues once it's used (grants/audit) — must go before the account row
      // or the FKs (principal_account_id / actor_account_id) block the delete.
      `DELETE FROM vault_envelopes WHERE principal_account_id IN ${byEmail};`,
      `DELETE FROM phi_access_events WHERE actor_account_id IN ${byEmail} OR subject_account_id IN ${byEmail};`,
      `DELETE FROM accounts WHERE email = ${sql(spec.email)};`,
    );
  }
  statements.push(
    `INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES (${sql(accountId)}, ${sql(spec.email)}, 0, ${sql(spec.displayName)}, 'active', 'support', ${sql(now)});`,
    `INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES (${sql(crypto.randomUUID())}, ${sql(accountId)}, 'password', NULL, NULL, ${sql(now)});`,
    `INSERT INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) VALUES (${sql(accountId)}, 'password', X'${toHex(wrapped)}', ${sql(JSON.stringify(kdfParams))}, ${sql(now)});`,
    `INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${sql(accountId)}, ${sql(JSON.stringify(publicKeyJwk))}, ${sql(now)});`,
  );
  // Deliberately no vault and no vault_envelopes row: the client treats a vaulted account as an owner,
  // and this principal owns nothing. Every record it ever opens is opened through someone's grant.
  return { accountId, statements };
}

async function main() {
  // DISPLAY_NAME, not DISPLAY: the latter collides with the X11 windowing system's env var (macOS
  // XQuartz exports it globally on some hosts), which silently overrode this fallback with a launchd
  // socket path instead of "Support Agent".
  const spec: SupportAccountSpec = {
    email: process.env.EMAIL ?? "support@local.invalid",
    password: process.env.PASSWORD ?? "support",
    displayName: process.env.DISPLAY_NAME ?? "Support Agent",
    ...(process.env.ACCOUNT_ID ? { accountId: process.env.ACCOUNT_ID } : {}),
    reset: process.env.RESET === "1",
  };
  const { accountId, statements } = await supportAccountSql(spec);
  process.stderr.write(`# support account ${spec.email} (id ${accountId}), password "${spec.password}" — apply the SQL on stdout with wrangler d1 execute --remote\n`);
  process.stdout.write(statements.join("\n") + "\n");
}
// Guarded, because tests/unit/support-principal.test.ts imports `supportAccountSql` from here and an
// unguarded entry point would mint an account — and print its password — on every import.
if (isMain(import.meta.url)) main().catch((e) => { process.stderr.write(`\u2717 ${(e as Error).message}\n`); process.exit(1); });
