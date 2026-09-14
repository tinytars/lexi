// W52 Phase 3 — close the credential blockers the W44 migration left behind.
//
// scripts/migrate-accounts.ts seeded each pilot's password credential with their own slug
// ("pablo", "liz"), and VAULT.md documented those values as current. That is one problem, not two:
// the password is BOTH the login secret AND the KEK that unwraps the account private key, which
// unwraps the vault DEK. So a guessable password means confidentiality currently rests on endpoint
// gating rather than on encryption — and W53 would copy exactly that into production.
//
// Rotating fixes both at once, because a new password re-derives a new KEK over the SAME private
// key. The DEK envelopes are wrapped to PUBLIC keys and are deliberately untouched: the vault
// ciphertext does not change, so nothing has to be re-encrypted and no other principal
// (provider, org recovery) loses access.
//
//   npm run vault:rotate                          # --check (default): report, write NOTHING
//   npm run vault:rotate -- --apply --account liz@local.invalid
//
// An account whose password is NOT a seed value can only be rotated if the holder's current password
// is supplied out of band, via the CURRENT_PASSWORD env var (never argv — that leaks into `ps` and
// shell history). Add --mint-org-envelope to also give the org a recovery envelope for that account's
// vault while the DEK is briefly in hand: accounts created through the app's signup path never got
// one, and nobody but a DEK holder can create it.
//
// --apply refuses to run without a recent snapshot: a botched re-wrap is recoverable only from the
// backup, which is why W52 orders Phase 1 before this one.
//
// The new password is printed ONCE to stdout and stored nowhere — not in this repo, not in the
// credentials repo. Deliver it to the account holder out of band; they can change it in-app.

import "./load-creds";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import {
  deriveKekFromPassword,
  deriveAuthHash,
  wrapPrivateKey,
  unwrapPrivateKey,
  unwrapDEKWithPrivateKey,
  wrapDEKForPublicKey,
  decryptVaultV2,
} from "@tinytars/vault/crypto";
import { hexToBytes, bytesToHex, loadOrgPublicKey } from "./org-key";
import { getObject, resolveStore, LIVE_BUCKET } from "./vault-sync";
import { checkFreshness } from "./vault-snapshot-check";
import { isV2 } from "./vault-v2";
import type { Vault } from "../src/lib/types";
import { wranglerTarget } from "./target";
import {
  weakCandidates,
  matchesSelector,
  parseRotateArgs,
  suppliedAppliesTo,
  rotationVerdict,
  type Method,
  type AccessResult,
} from "../src/lib/credential-rotation";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const WRANGLER = resolve(here, "wrangler.sh");
// W53 P4: derived from the worktree's wrangler.jsonc — see scripts/target.ts.
const D1_DATABASE = wranglerTarget().database;

const KDF_ITERATIONS = 200_000; // must match src/lib/crypto.ts and migrate-accounts.ts
const SNAPSHOT_MAX_AGE_HOURS = 6;

async function d1<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("bash", [WRANGLER, "d1", "execute", D1_DATABASE, "--remote", "--json", "--command", sql], {
    cwd: APP,
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as Array<{ results: T[] }>)[0].results;
}

const sha256B64url = async (s: string): Promise<string> =>
  Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64url");

interface CredentialRow {
  account_id: string;
  email: string | null;
  display_name: string;
  wpk: string; // hex
  kdf_params: string;
}

interface Kdf {
  salt: string;
  iterations: number;
  authHashSha256: string;
}

// A "recovery" credential is not a lesser secret: it wraps the same account private key under the
// same scheme, so a guessable recovery code is a guessable vault key. Rotating one method and not
// the other leaves the hole exactly where it was.

const loadCredentials = (method: Method): Promise<CredentialRow[]> =>
  d1<CredentialRow>(
    `SELECT c.account_id, a.email, a.display_name, hex(c.wrapped_private_key) AS wpk, c.kdf_params ` +
      `FROM credentials c JOIN accounts a ON a.id = c.account_id WHERE c.method = '${method}'`,
  );

export interface CredentialAudit {
  accountId: string;
  email: string | null;
  displayName: string;
  knownPassword?: string;
  seeded: boolean; // the known password is the W44 seed value, i.e. guessable by anyone
  unwrapsPrivateKey: boolean;
}

// `supplied` is the account holder's real current password, handed over out of band by the owner
// (env CURRENT_PASSWORD — never argv, which leaks into `ps` and shell history). It is the only way
// to rotate an account whose password is NOT guessable, since rotation has to unwrap the existing
// private key before it can re-wrap it.
async function auditRow(row: CredentialRow, method: Method, supplied?: string): Promise<CredentialAudit> {
  const kdf = JSON.parse(row.kdf_params) as Kdf;
  const salt = hexToBytes(kdf.salt);
  const base: CredentialAudit = {
    accountId: row.account_id,
    email: row.email,
    displayName: row.display_name,
    seeded: false,
    unwrapsPrivateKey: false,
  };
  const seeds = weakCandidates({ email: row.email, displayName: row.display_name }, method);
  for (const candidate of [...(supplied ? [supplied] : []), ...seeds]) {
    if ((await sha256B64url(await deriveAuthHash(candidate, salt))) !== kdf.authHashSha256) continue;
    let unwraps = false;
    try {
      await unwrapPrivateKey(hexToBytes(row.wpk), await deriveKekFromPassword(candidate, salt));
      unwraps = true;
    } catch {
      unwraps = false;
    }
    return { ...base, knownPassword: candidate, seeded: seeds.includes(candidate), unwrapsPrivateKey: unwraps };
  }
  return base;
}

// Which principal is the org operational key, discovered by matching the committed org public key
// against public_keys — same approach as the restore drill, so no account id is hardcoded twice.
let orgAccountIdCache: string | undefined;
async function orgAccountId(): Promise<string> {
  if (orgAccountIdCache) return orgAccountIdCache;
  const pub = loadOrgPublicKey();
  const rows = await d1<{ account_id: string; public_key_jwk: string }>(`SELECT account_id, public_key_jwk FROM public_keys`);
  const hit = rows.find((r) => {
    const j = JSON.parse(r.public_key_jwk) as JsonWebKey;
    return j.kty === pub.kty && j.crv === pub.crv && j.x === pub.x && j.y === pub.y;
  });
  if (!hit) throw new Error("no public_keys row matches records/org-key.json — cannot identify the org principal");
  orgAccountIdCache = hit.account_id;
  return hit.account_id;
}

// 20 chars from a 62-symbol alphabet ≈ 119 bits. Generated here and shown once; the operator hands
// it to the account holder, who can replace it in-app. rejection-sampled so the alphabet is uniform.
function generatePassword(length = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 256 - (256 % alphabet.length)) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface RotationResult {
  accountId: string;
  email: string | null;
  newPassword: string;
  expectedVaults: number;
  oldPasswordStillWorks: boolean;
  access: AccessResult[];
  orgEnvelopesMinted: string[];
}

// Open every vault this account holds an envelope for, using its private key. This is the real
// question a rotation has to answer: not "did the row update" but "can this principal still read
// exactly what it could read before".
async function verifyAccess(accountId: string, privateKey: CryptoKey, store: string): Promise<AccessResult[]> {
  const rows = await d1<{ vault_id: string; r2_key: string; wrapped_dek: string; ephemeral_public_key_jwk: string }>(
    `SELECT e.vault_id, v.r2_key, hex(e.wrapped_dek) AS wrapped_dek, e.ephemeral_public_key_jwk ` +
      `FROM vault_envelopes e JOIN vaults v ON v.vault_id = e.vault_id ` +
      `WHERE e.principal_account_id = '${accountId}'`,
  );
  const out: AccessResult[] = [];
  for (const r of rows) {
    try {
      const blob = await getObject(LIVE_BUCKET, `${store}/${r.r2_key}`);
      if (!blob) throw new Error(`no object at ${store}/${r.r2_key}`);
      if (!isV2(blob)) throw new Error("not an HD1 v2 blob");
      const dek = await unwrapDEKWithPrivateKey(
        hexToBytes(r.wrapped_dek),
        JSON.parse(r.ephemeral_public_key_jwk) as JsonWebKey,
        privateKey,
      );
      const vault = await decryptVaultV2<Vault>(blob, dek);
      out.push({ vaultId: r.vault_id, r2Key: r.r2_key, ok: !!vault && typeof vault.clients === "object" });
    } catch (e) {
      out.push({ vaultId: r.vault_id, r2Key: r.r2_key, ok: false, detail: (e as Error).message });
    }
  }
  return out;
}

async function dekFor(
  accountId: string,
  vaultId: string,
  r2Key: string,
  privateKey: CryptoKey,
  store: string,
): Promise<CryptoKey | null> {
  const env = await d1<{ wrapped_dek: string; ephemeral_public_key_jwk: string }>(
    `SELECT hex(wrapped_dek) AS wrapped_dek, ephemeral_public_key_jwk FROM vault_envelopes ` +
      `WHERE vault_id = '${vaultId}' AND principal_account_id = '${accountId}'`,
  );
  if (!env.length) return null;
  const blob = await getObject(LIVE_BUCKET, `${store}/${r2Key}`);
  if (!blob || !isV2(blob)) return null;
  return unwrapDEKWithPrivateKey(
    hexToBytes(env[0].wrapped_dek),
    JSON.parse(env[0].ephemeral_public_key_jwk) as JsonWebKey,
    privateKey,
  );
}

async function rotateOne(
  row: CredentialRow,
  method: Method,
  current: string,
  store: string,
  mintOrgEnvelope: boolean,
): Promise<RotationResult> {
  const kdf = JSON.parse(row.kdf_params) as Kdf;
  const oldSalt = hexToBytes(kdf.salt);

  // Counted BEFORE the credential is replaced. Without this denominator "nothing came back" and
  // "nothing was there" are the same reading, and only one of them is safe — see rotationVerdict.
  const expectedVaults =
    (await d1<{ n: number }>(`SELECT COUNT(*) AS n FROM vault_envelopes WHERE principal_account_id = '${row.account_id}'`))[0]?.n ?? 0;

  // Recover the account private key with the credential that is being retired — this is the only
  // moment it exists in the clear, and it never leaves this process.
  const privateKey = await unwrapPrivateKey(hexToBytes(row.wpk), await deriveKekFromPassword(current, oldSalt));

  const newPassword = generatePassword();
  const newSalt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const wrapped = await wrapPrivateKey(privateKey, await deriveKekFromPassword(newPassword, newSalt));
  const authHashSha256 = await sha256B64url(await deriveAuthHash(newPassword, newSalt));
  const newKdf: Kdf = { salt: bytesToHex(newSalt), iterations: KDF_ITERATIONS, authHashSha256 };

  await d1(
    `UPDATE credentials SET wrapped_private_key = X'${bytesToHex(wrapped)}', ` +
      `kdf_params = '${JSON.stringify(newKdf)}' ` +
      `WHERE account_id = '${row.account_id}' AND method = '${method}'`,
  );

  // Re-read from D1 and prove three things about what actually landed, not about what we sent:
  // the old password is dead, the new one works, and the vault still opens through it.
  const [after] = await d1<CredentialRow>(
    `SELECT c.account_id, a.email, a.display_name, hex(c.wrapped_private_key) AS wpk, c.kdf_params ` +
      `FROM credentials c JOIN accounts a ON a.id = c.account_id ` +
      `WHERE c.account_id = '${row.account_id}' AND c.method = '${method}'`,
  );
  const afterKdf = JSON.parse(after.kdf_params) as Kdf;
  const afterSalt = hexToBytes(afterKdf.salt);
  const oldPasswordStillWorks =
    (await sha256B64url(await deriveAuthHash(current, afterSalt))) === afterKdf.authHashSha256;

  const rotatedKey = await unwrapPrivateKey(hexToBytes(after.wpk), await deriveKekFromPassword(newPassword, afterSalt));

  // Every vault this account can reach, not just the ones it OWNS. A provider or support account
  // owns nothing and holds envelopes into other people's vaults, so an owner-only check reports a
  // perfectly good rotation as a failure — and, worse, would stay silent if the rotation actually
  // did break a provider's access to a patient.
  const access = await verifyAccess(row.account_id, rotatedKey, store);

  const orgEnvelopesMinted: string[] = [];
  if (mintOrgEnvelope) {
    // Accounts created through the app's signup path never got an org-recovery envelope (found by
    // the W52 restore drill). The org cannot mint one on its own — only a holder of the DEK can, and
    // holding the DEK is exactly what this rotation transiently does. Without it the vault is
    // unrecoverable the moment the account holder loses their password, and no backup fixes that.
    const orgId = await orgAccountId();
    const owned = await d1<{ vault_id: string; r2_key: string }>(
      `SELECT vault_id, r2_key FROM vaults WHERE owner_account_id = '${row.account_id}'`,
    );
    for (const v of owned) {
      const existing = await d1<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vault_envelopes WHERE vault_id = '${v.vault_id}' AND principal_account_id = '${orgId}'`,
      );
      if (existing[0]?.n) continue;
      const dek = await dekFor(row.account_id, v.vault_id, v.r2_key, rotatedKey, store);
      if (!dek) continue;
      const orgEnv = await wrapDEKForPublicKey(dek, loadOrgPublicKey());
      await d1(
        `INSERT INTO vault_envelopes (vault_id, principal_account_id, wrapped_dek, ephemeral_public_key_jwk, created_by, created_at) ` +
          `VALUES ('${v.vault_id}', '${orgId}', X'${bytesToHex(orgEnv.wrappedDEK)}', ` +
          `'${JSON.stringify(orgEnv.ephemeralPublicKeyJwk)}', '${orgId}', datetime('now'))`,
      );
      orgEnvelopesMinted.push(v.vault_id);
    }
  }

  return { accountId: row.account_id, email: row.email, newPassword, expectedVaults, oldPasswordStillWorks, access, orgEnvelopesMinted };
}

const matches = (row: CredentialRow, sel: string[]): boolean => matchesSelector({ accountId: row.account_id, email: row.email }, sel);

async function main(): Promise<void> {
  const args = parseRotateArgs(process.argv, process.env);
  const { method, selectors: sel, supplied } = args;
  const rows = await loadCredentials(method);
  const suppliedApplies = (row: CredentialRow) => suppliedAppliesTo({ accountId: row.account_id, email: row.email }, args);

  // Read-only: prove an account can still open everything it holds an envelope for, given its
  // current password. Answers "did that rotation cost anyone access?" without changing anything.
  if (args.mode === "verify-access") {
    const store = resolveStore();
    let lostTotal = 0;
    for (const row of rows.filter((r) => matches(r, sel))) {
      const kdf = JSON.parse(row.kdf_params) as Kdf;
      const key = await unwrapPrivateKey(hexToBytes(row.wpk), await deriveKekFromPassword(supplied!, hexToBytes(kdf.salt)));
      const access = await verifyAccess(row.account_id, key, store);
      const lost = access.filter((a) => !a.ok);
      lostTotal += lost.length;
      process.stdout.write(
        `  ${lost.length ? "FAIL" : "ok  "} ${(row.email ?? row.account_id).padEnd(32)} readable: ${access.length - lost.length}/${access.length}\n`,
      );
      for (const a of access) {
        process.stdout.write(`       ${a.ok ? "ok  " : "FAIL"} ${a.r2Key}${a.detail ? " — " + a.detail : ""}\n`);
      }
    }
    process.exit(lostTotal ? 1 : 0);
  }

  if (args.mode === "check") {
    process.stdout.write(`${method} credentials — is a value this repo documented still live?\n\n`);
    let weakCount = 0;
    for (const r of rows) {
      const a = await auditRow(r, method, suppliedApplies(r) ? supplied : undefined);
      if (a.seeded) weakCount++;
      const tag = a.seeded ? "WEAK" : a.knownPassword ? "known" : "ok  ";
      process.stdout.write(
        `  ${tag.padEnd(5)} ${(a.email ?? "-").padEnd(32)} ${a.displayName.padEnd(20)}` +
          (a.seeded
            ? `  password is "${a.knownPassword}"${a.unwrapsPrivateKey ? " — and it unwraps the private key → the vault DEK" : ""}\n`
            : a.knownPassword
              ? "  supplied password verified — rotatable\n"
              : "\n"),
      );
    }
    process.stdout.write(
      weakCount
        ? `\n${weakCount} account(s) still on the seeded value. Rotate: npm run vault:rotate -- --apply --account <email>\n`
        : "\nno account is on a seeded value.\n",
    );
    process.exit(weakCount ? 1 : 0);
  }

  // Ordering invariant from W52: never rotate what you cannot roll back to.
  const fresh = await checkFreshness(SNAPSHOT_MAX_AGE_HOURS);
  if (!fresh.ok) {
    throw new Error(
      `refusing to rotate without a recent backup — ${fresh.reason}\n` +
        `  run: npm run vault:snapshot && npm run vault:restore`,
    );
  }
  process.stdout.write(`backup ok — snapshot ${fresh.snapshotId} is ${fresh.ageHours!.toFixed(1)}h old\n\n`);

  const targets = rows.filter((r) => matches(r, sel));
  if (!targets.length) throw new Error(`no password credential matches: ${sel.join(", ")}`);

  const mintOrgEnvelope = args.mintOrgEnvelope;
  const store = resolveStore();
  const results: RotationResult[] = [];
  for (const row of targets) {
    const a = await auditRow(row, method, suppliedApplies(row) ? supplied : undefined);
    if (!a.knownPassword) {
      process.stdout.write(
        `  skip ${row.email} — current password unknown (not a seed value, none supplied), so the private ` +
          `key cannot be unwrapped and the account cannot be rotated from here\n`,
      );
      continue;
    }
    results.push(await rotateOne(row, method, a.knownPassword, store, mintOrgEnvelope));
  }

  let bad = 0;
  process.stdout.write("\nrotated:\n");
  for (const r of results) {
    const verdict = rotationVerdict(r);
    if (!verdict.ok) bad++;
    const readable = r.access.filter((a) => a.ok).length;
    process.stdout.write(
      `  ${verdict.ok ? "ok  " : "FAIL"} ${(r.email ?? r.accountId).padEnd(32)} new password: ${r.newPassword}\n` +
        `       old password rejected: ${!r.oldPasswordStillWorks}   vaults still readable: ${readable}/${r.expectedVaults}` +
        (r.orgEnvelopesMinted.length ? `   org-recovery envelope minted for ${r.orgEnvelopesMinted.length} vault(s)` : "") +
        "\n",
    );
    for (const reason of verdict.reasons) process.stdout.write(`       ${reason}\n`);
  }
  process.stdout.write(
    "\nThe passwords above are shown ONCE and stored nowhere. Deliver them out of band, then " +
      "update VAULT.md §Keys if it still describes the old values.\n",
  );
  if (bad) process.exit(1);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
