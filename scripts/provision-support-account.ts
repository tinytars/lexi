// W44 P4b — provision a support agent account in remote D1 (out-of-band; no self-service signup exists
// for provider_kind='support', and support must NOT own a vault — the client treats a vaulted account as
// an owner). Computes the crypto locally and emits a SQL file to apply with wrangler d1 execute --remote.
// A support account = accounts(provider_kind='support') + a password credential (wrapped key + verifier)
// + public_key + identity(password). NO vault. Password is documented in AUTH.md like the fam4 pilot.
//
//   EMAIL=support@local.invalid PASSWORD=support DISPLAY_NAME="Support Agent" \
//     NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npx tsx scripts/provision-support-account.ts > /tmp/support.sql
//   npm run wrangler -- d1 execute health-identity-dev --remote --file /tmp/support.sql

import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey, deriveAuthHash } from "@tinytars/vault/crypto";

const EMAIL = process.env.EMAIL ?? "support@local.invalid";
const PASSWORD = process.env.PASSWORD ?? "support";
// Named DISPLAY_NAME, not DISPLAY: the latter collides with the X11 windowing system's env var
// (macOS XQuartz exports it globally on some hosts), which silently overrode this fallback with a
// launchd socket path instead of "Support Agent".
const DISPLAY_NAME = process.env.DISPLAY_NAME ?? "Support Agent";
const ACCOUNT_ID = process.env.ACCOUNT_ID; // fixed id for idempotent re-provision (else random)
const RESET = process.env.RESET === "1"; // delete any existing account for this email first (e2e-safe; NOT for prod re-provision — would orphan provider_links)
const ITER = 200_000;

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
async function sha256Base64Url(s: string): Promise<string> {
  const d = new Uint8Array(await (globalThis.crypto as Crypto).subtle.digest("SHA-256", enc.encode(s)));
  return Buffer.from(d).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const sql = (s: string) => "'" + s.replace(/'/g, "''") + "'";

async function main() {
  const now = "2026-07-07T00:00:00Z";
  const accountId = ACCOUNT_ID ?? crypto.randomUUID();
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();

  const salt = rand(16);
  const kek = await deriveKekFromPassword(PASSWORD, salt);
  const wrapped = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(PASSWORD, salt);
  const kdfParams = { salt: toHex(salt), iterations: ITER, authHashSha256: await sha256Base64Url(authHash) };

  const lines: string[] = [];
  if (RESET) {
    // idempotent re-provision (e2e): drop any prior account for this email + its child rows first.
    const byEmail = `(SELECT id FROM accounts WHERE email = ${sql(EMAIL)})`;
    lines.push(
      `DELETE FROM credentials WHERE account_id IN ${byEmail};`,
      `DELETE FROM identities WHERE account_id IN ${byEmail};`,
      `DELETE FROM public_keys WHERE account_id IN ${byEmail};`,
      `DELETE FROM provider_links WHERE provider_account_id IN ${byEmail} OR patient_account_id IN ${byEmail};`,
      // rows the support account accrues once it's used (grants/audit) — must go before the account row
      // or the FKs (principal_account_id / actor_account_id) block the delete.
      `DELETE FROM vault_envelopes WHERE principal_account_id IN ${byEmail};`,
      `DELETE FROM phi_access_events WHERE actor_account_id IN ${byEmail} OR subject_account_id IN ${byEmail};`,
      `DELETE FROM accounts WHERE email = ${sql(EMAIL)};`,
    );
  }
  lines.push(
    `INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES (${sql(accountId)}, ${sql(EMAIL)}, 0, ${sql(DISPLAY_NAME)}, 'active', 'support', ${sql(now)});`,
    `INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES (${sql(crypto.randomUUID())}, ${sql(accountId)}, 'password', NULL, NULL, ${sql(now)});`,
    `INSERT INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) VALUES (${sql(accountId)}, 'password', X'${toHex(wrapped)}', ${sql(JSON.stringify(kdfParams))}, ${sql(now)});`,
    `INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${sql(accountId)}, ${sql(JSON.stringify(publicKeyJwk))}, ${sql(now)});`,
  );
  process.stderr.write(`# support account ${EMAIL} (id ${accountId}), password "${PASSWORD}" — apply the SQL on stdout with wrangler d1 execute --remote\n`);
  process.stdout.write(lines.join("\n") + "\n");
}
main().catch((e) => { process.stderr.write(`✗ ${(e as Error).message}\n`); process.exit(1); });
