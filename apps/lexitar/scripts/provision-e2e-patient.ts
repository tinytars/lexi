// W69 — provision a fully synthetic patient for one Playwright worker. LOCAL ONLY.
//
// Modelled on provision-support-account.ts: compute the crypto here, emit SQL on stdout, apply it with
// `wrangler d1 execute --local`. The difference is that this account OWNS a vault, so it also needs a
// DEK, an encrypted blob, and envelopes wrapping that DEK to the principals allowed to open it.
//
// Nothing here needs a secret, which is the whole point:
//   • the patient's password IS the slug (public, exactly like the alex/blair pilots)
//   • wrapDEKForPublicKey takes the recipient's PUBLIC jwk — the provider's is already sitting in
//     migration 0002 in plaintext, so granting the provider access requires nothing private
//   • no org envelope is written; ORG_KEY_PASSPHRASE is only ever needed to open the REAL pilots' blobs
// That is what makes e2e able to run somewhere other than this Mac.
//
//   E2E_WORKERS=4 OUT=dist npx tsx scripts/provision-e2e-patient.ts > /tmp/e2e.sql
//   npx wrangler d1 execute health-identity-dev --local --persist-to .wrangler/state --file /tmp/e2e.sql
//
// Idempotent by construction: fixed ids per seed plus a RESET-style delete, so a persisted
// .wrangler/state re-seeds cleanly across restarts.

import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  generateAccountKeypair,
  deriveKekFromPassword,
  wrapPrivateKey,
  deriveAuthHash,
  generateDEK,
  wrapDEKForPublicKey,
  encryptVaultV2,
} from "@tinytars/vault/crypto";
import {
  syntheticVault,
  syntheticTag,
  SYNTHETIC_WORKER_COUNT,
  FRESH_SEED,
  type SyntheticClientOptions,
} from "../tests/fixtures/synthetic-patient";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");

const OUT_DIR = process.env.OUT ?? "dist";
const ITER = 200_000;

// W69 — the synthetic patients get their OWN clinician, never the pilots' fam4.
//
// Linking them to fam4 LOOKED additive and was not: provider_links feed the roster, so four synthetic
// patients appeared on the real provider's roster and broke cover-render.spec.ts:47, which asserts the
// roster contents exactly. The roster is shared state, and that test was right to notice.
//
// It also removes the last credential from this path. fam4's password IS the family PASSPHRASE (its
// verifier is baked into migration 0002), which is exactly what stops e2e running anywhere but this
// Mac. This clinician's password is a literal, so the synthetic world needs nothing secret end to end.
export const E2E_PROVIDER = {
  accountId: "e2e0c000-0000-4000-8000-0000000000c0",
  identityId: "e2e0d000-0000-4000-8000-0000000000c0",
  email: "e2e-clinician@local.invalid",
  password: "e2e-clinician",
  displayName: "E2E Clinician",
};

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sql = (s: string) => "'" + s.replace(/'/g, "''") + "'";

async function sha256Base64Url(s: string): Promise<string> {
  const d = new Uint8Array(await (globalThis.crypto as Crypto).subtle.digest("SHA-256", enc.encode(s)));
  return Buffer.from(d).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Deterministic ids per seed, so re-provisioning replaces rather than accumulates.
 *
 * Shaped like a UUID because the columns are compared against real ones; `w0` -> `...0`, and the
 * digits are taken from the seed so two workers can never collide. `FRESH_SEED` carries no digit at
 * all, so it gets a fixed high suffix reserved for it — safe as long as the worker count stays under
 * that reservation (SYNTHETIC_WORKER_COUNT is 4 today).
 */
function idsFor(seed: string): { account: string; vault: string; link: string; identity: string } {
  const n = seed === FRESH_SEED ? "99" : seed.replace(/\D/g, "").padStart(2, "0").slice(-2);
  return {
    account: `e2e0a${n}0-0000-4000-8000-0000000000${n}`,
    vault: `e2e0v${n}0-0000-4000-8000-0000000000${n}`,
    link: `e2e0l${n}0-0000-4000-8000-0000000000${n}`,
    identity: `e2e0i${n}0-0000-4000-8000-0000000000${n}`,
  };
}

export interface ProvisionedPatient {
  slug: string;
  email: string;
  password: string;
  r2Key: string;
  blob: Uint8Array;
  /** The account's own private key — returned so a test can prove the envelope actually opens. */
  privateKey: CryptoKey;
  ownerEnvelope: Awaited<ReturnType<typeof wrapDEKForPublicKey>>;
  sql: string[];
}

/**
 * Everything the CLI emits, as data — so the crypto can be round-tripped in a unit test instead of
 * being trusted. A wrapped DEK that does not open is indistinguishable from one that does until a
 * browser tries to log in, at which point it surfaces as an opaque "cannot unwrap DEK".
 */
export async function provisionPatient(
  seed: string,
  providerPublicKeyJwk: JsonWebKey,
  opts: SyntheticClientOptions = {},
): Promise<ProvisionedPatient> {
  const now = "2026-07-07T00:00:00Z";
  const SEED = seed;
  const slug = `e2e-${SEED}`;
  const email = `${slug}@local.invalid`;
  const password = slug; // public, exactly like the alex/blair pilots
  const r2Key = `data-${slug}.enc`;
  const ids = idsFor(SEED);

  // 1 — the account's own keypair, unlocked by a password-derived KEK.
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  const kek = await deriveKekFromPassword(password, salt);
  const wrappedPrivateKey = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(password, salt);
  const kdfParams = { salt: toHex(salt), iterations: ITER, authHashSha256: await sha256Base64Url(authHash) };

  // 2 — the vault: a fresh DEK, the synthetic content encrypted under it, and one envelope per
  // principal who may open it (the patient, and the clinician who drills in from the roster).
  const dek = await generateDEK();
  const blob = await encryptVaultV2(syntheticVault(slug, opts), dek);
  const ownerEnvelope = await wrapDEKForPublicKey(dek, publicKeyJwk);
  // The clinician's key is PASSED IN, not read from a migration: that account is minted fresh on each
  // boot, so its keypair only exists within the run that created it. Provisioning the whole synthetic
  // world in one invocation is what keeps this honest — see provisionWorld().
  const providerEnvelope = await wrapDEKForPublicKey(dek, providerPublicKeyJwk);

  const byEmail = `(SELECT id FROM accounts WHERE email = ${sql(email)})`;
  const lines = [
    // Idempotent re-provision. Child rows first — the FKs block the account delete otherwise.
    `DELETE FROM vault_envelopes WHERE vault_id = ${sql(ids.vault)} OR principal_account_id IN ${byEmail};`,
    `DELETE FROM phi_access_events WHERE actor_account_id IN ${byEmail} OR subject_account_id IN ${byEmail};`,
    `DELETE FROM provider_links WHERE patient_account_id IN ${byEmail} OR provider_account_id IN ${byEmail};`,
    `DELETE FROM vaults WHERE vault_id = ${sql(ids.vault)} OR owner_account_id IN ${byEmail};`,
    `DELETE FROM credentials WHERE account_id IN ${byEmail};`,
    `DELETE FROM identities WHERE account_id IN ${byEmail};`,
    `DELETE FROM public_keys WHERE account_id IN ${byEmail};`,
    `DELETE FROM accounts WHERE email = ${sql(email)};`,

    `INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES (${sql(ids.account)}, ${sql(email)}, 1, ${sql(`Synthetic ${syntheticTag(slug)}`)}, 'active', NULL, ${sql(now)});`,
    `INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES (${sql(ids.identity)}, ${sql(ids.account)}, 'password', NULL, NULL, ${sql(now)});`,
    `INSERT INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) VALUES (${sql(ids.account)}, 'password', X'${toHex(wrappedPrivateKey)}', ${sql(JSON.stringify(kdfParams))}, ${sql(now)});`,
    `INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${sql(ids.account)}, ${sql(JSON.stringify(publicKeyJwk))}, ${sql(now)});`,

    `INSERT INTO vaults (vault_id, owner_account_id, r2_key, hd1_version) VALUES (${sql(ids.vault)}, ${sql(ids.account)}, ${sql(r2Key)}, 2);`,
    `INSERT INTO vault_envelopes (vault_id, principal_account_id, wrapped_dek, ephemeral_public_key_jwk, created_by, created_at) VALUES (${sql(ids.vault)}, ${sql(ids.account)}, X'${toHex(ownerEnvelope.wrappedDEK)}', ${sql(JSON.stringify(ownerEnvelope.ephemeralPublicKeyJwk))}, ${sql(ids.account)}, ${sql(now)});`,
    `INSERT INTO vault_envelopes (vault_id, principal_account_id, wrapped_dek, ephemeral_public_key_jwk, created_by, created_at) VALUES (${sql(ids.vault)}, ${sql(E2E_PROVIDER.accountId)}, X'${toHex(providerEnvelope.wrappedDEK)}', ${sql(JSON.stringify(providerEnvelope.ephemeralPublicKeyJwk))}, ${sql(ids.account)}, ${sql(now)});`,
    `INSERT INTO provider_links (id, patient_account_id, provider_account_id, role, status, consent_ref, granted_by, granted_at) VALUES (${sql(ids.link)}, ${sql(ids.account)}, ${sql(E2E_PROVIDER.accountId)}, 'primary', 'active', 'e2e', ${sql(ids.account)}, ${sql(now)});`,
  ];

  return { slug, email, password, r2Key, blob, privateKey, ownerEnvelope, sql: lines };
}

/** The clinician account itself: a login, a keypair, and no vault of its own. */
async function provisionProvider(): Promise<{ sql: string[]; publicKeyJwk: JsonWebKey }> {
  const now = "2026-07-07T00:00:00Z";
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const salt = rand(16);
  const kek = await deriveKekFromPassword(E2E_PROVIDER.password, salt);
  const wrapped = await wrapPrivateKey(privateKey, kek);
  const authHash = await deriveAuthHash(E2E_PROVIDER.password, salt);
  const kdfParams = { salt: toHex(salt), iterations: ITER, authHashSha256: await sha256Base64Url(authHash) };
  const byEmail = `(SELECT id FROM accounts WHERE email = ${sql(E2E_PROVIDER.email)})`;
  return {
    publicKeyJwk,
    sql: [
      `DELETE FROM vault_envelopes WHERE principal_account_id IN ${byEmail};`,
      `DELETE FROM phi_access_events WHERE actor_account_id IN ${byEmail} OR subject_account_id IN ${byEmail};`,
      `DELETE FROM provider_links WHERE provider_account_id IN ${byEmail} OR patient_account_id IN ${byEmail};`,
      `DELETE FROM credentials WHERE account_id IN ${byEmail};`,
      `DELETE FROM identities WHERE account_id IN ${byEmail};`,
      `DELETE FROM public_keys WHERE account_id IN ${byEmail};`,
      `DELETE FROM accounts WHERE email = ${sql(E2E_PROVIDER.email)};`,
      // provider_kind 'primary' — the value _lib/capabilities.ts's Role type and every route that
      // calls can(roleOf(...), ...) actually check for. Migration 0002 seeded the real fam4 pilot
      // account with the string 'clinician' instead, which is why fam4 has never been able to pass
      // an "ai:spend"/"recovery:issue" check in production — a latent bug in that seed data, not a
      // convention this account should match. Flagged separately; not this e2e fixture's job to fix.
      `INSERT INTO accounts (id, email, email_confirmed, display_name, lifecycle_stage, provider_kind, created_at) VALUES (${sql(E2E_PROVIDER.accountId)}, ${sql(E2E_PROVIDER.email)}, 1, ${sql(E2E_PROVIDER.displayName)}, 'active', 'primary', ${sql(now)});`,
      `INSERT INTO identities (id, account_id, method, provider_subject, credential_id, created_at) VALUES (${sql(E2E_PROVIDER.identityId)}, ${sql(E2E_PROVIDER.accountId)}, 'password', NULL, NULL, ${sql(now)});`,
      `INSERT INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) VALUES (${sql(E2E_PROVIDER.accountId)}, 'password', X'${toHex(wrapped)}', ${sql(JSON.stringify(kdfParams))}, ${sql(now)});`,
      `INSERT INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${sql(E2E_PROVIDER.accountId)}, ${sql(JSON.stringify(publicKeyJwk))}, ${sql(now)});`,
    ],
  };
}

/**
 * The clinician plus `count` patients, in ONE run.
 *
 * One invocation rather than a loop of them, because the clinician's private key exists only inside
 * the process that generated it — a per-patient process would have to either re-mint the clinician
 * (invalidating the previous patients' envelopes) or persist a private key to disk.
 */
export async function provisionWorld(count: number): Promise<{ sql: string[]; patients: ProvisionedPatient[] }> {
  const provider = await provisionProvider();
  const patients: ProvisionedPatient[] = [];
  for (let i = 0; i < count; i++) patients.push(await provisionPatient(`w${i}`, provider.publicKeyJwk));
  patients.push(await provisionPatient(FRESH_SEED, provider.publicKeyJwk, { fresh: true }));
  return { sql: [...provider.sql, ...patients.flatMap((p) => p.sql)], patients };
}

async function main(): Promise<void> {
  const count = Number(process.env.E2E_WORKERS ?? SYNTHETIC_WORKER_COUNT);
  const { sql: lines, patients } = await provisionWorld(count);
  // The blob goes where the Function looks for it. functions/api/vault/[id].ts:131 fetches
  // /data-{id}.enc from ASSETS on an R2 miss and self-seeds local R2 from it, so dist/ is enough.
  // NOT records/public/: vite.config.ts:102 copies that directory into every build, which would ship
  // synthetic patient ciphertext to a public production URL forever.
  const outDir = resolve(APP, OUT_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const p of patients) writeFileSync(join(outDir, p.r2Key), p.blob);
  process.stderr.write(`# e2e clinician ${E2E_PROVIDER.email} / "${E2E_PROVIDER.password}"\n`);
  for (const p of patients) process.stderr.write(`# e2e patient ${p.email} / "${p.password}" — ${p.r2Key} (${p.blob.length} B) -> ${OUT_DIR}/\n`);
  process.stdout.write(lines.join("\n") + "\n");
}

// Only provision when RUN as a script. Without this guard, importing the module for a test executes
// main() as a side effect — writing a blob into dist/ and dumping SQL to stdout from a unit run.
// Same idiom as scripts/vault-verify.ts:123.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`✗ ${(e as Error).message}\n`);
    process.exit(1);
  });
}
