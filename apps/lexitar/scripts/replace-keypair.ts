// Replace the account keypairs whose private halves were published, and install the new org public
// key. The second half of the remediation's Phase 3; scripts/vault-rekey.ts is the first half and
// must run immediately AFTER this, never before.
//
// WHAT WAS PUBLISHED. apps/lexitar/migrations/0002_seed_migrated_accounts.sql, tracked on a public
// branch for 22 days, carried for each of three accounts an EC P-256 private key wrapped under that
// account's own slug — with the slug printed in plaintext on the adjacent line. Anyone holding a
// clone holds those private keys. Four of the public keys in that file are byte-identical to the
// rows live in `public_keys` today, which is the measurement that the W52 password rotation did not
// replace a keypair: it re-derived a new KEK over the SAME private key and left the DEK envelopes
// alone, deliberately and correctly for what it was for.
//
// WHY THE ORDER IS THIS WAY ROUND, AND WHY IT IS NOT A PREFERENCE. The DEK rotation wraps a fresh
// DEK to whatever public key each principal holds at that moment. Run it first and it wraps a fresh
// DEK to a published key — a rotation that completes, verifies, prints a tick and leaves the vault
// exactly as readable as before, with nothing about the vault afterwards saying so. So the keypairs
// are replaced first, which deliberately leaves every envelope wrapped to a key nobody holds the
// private half of any more, and the rotation that runs next is what re-mints them. The window
// between the two commands is one in which the account cannot open its own record. That is stated
// rather than engineered away: making it atomic would mean one command doing both, and the thing
// most worth refusing — a vault the rotation will not take — is only knowable per vault.
//
// WHICH STORE. scripts/target.ts reads the standing checkout's wrangler.jsonc, so the worktree you
// are standing in decides, and STORE_PREFIX alone does not move it. describeTarget() is printed
// before anything remote is touched.
//
// WHAT HAPPENS TO THE OTHER CREDENTIAL METHODS, AND WHY IT IS NOT THIS SCRIPT'S INVENTION. Each
// account's credentials rows all wrap the SAME private key under different KEKs. Replacing the
// keypair invalidates every one of them at once, and only the PBKDF2-derived ones can be rewritten
// from a terminal — a WebAuthn PRF lives on a physical authenticator and a federated KEK comes out
// of an OAuth flow. Both are therefore deleted, which is exactly what functions/_lib/recovery.ts's
// `activateStatements` already does in production on the same event, for a reason stronger than
// "the KEK is unreachable": auth/recovery/login.ts mints a full session on an authHash compare
// BEFORE any key is used, so a stale credential row would still hand out a session for an account
// it can no longer open. Leaving them would be worse than useless. The holder re-registers the
// passkey and the Google link in the app; until they do, those two buttons do not work for them.
//
// WHY ONE --command AND NOT SIX. A multi-statement `wrangler d1 execute --command` runs as a single
// implicit transaction — measured on dev against a throwaway table, where two conflicting inserts
// in one command failed with APIError 7500 and rolled the valid first one back. A half-applied swap
// (public key replaced, credentials not) is an account that can never be opened again by anybody,
// with no error at the moment it happens. One command is the only safe spelling.
//
//   npm run keypair:replace                              # --check (default): report, write NOTHING
//   npm run keypair:replace -- --apply --org
//   npm run keypair:replace -- --apply --account <uuid>   # repeatable
//   npm run keypair:replace -- --apply --all
//
// The new secrets are printed ONCE to stdout and stored nowhere — not in this repo, not in the
// credential store. Deliver them to the account holder out of band; they can change them in-app.
import "./load-creds";
import { randomBytes, randomInt } from "node:crypto";
import {
  generateAccountKeypair,
  deriveKekFromPassword,
  deriveAuthHash,
  wrapPrivateKey,
} from "@tinytars/vault/crypto";
import { PBKDF2_ITERATIONS, SALT_LEN } from "@tinytars/vault/kdf";
import { sha256Base64Url } from "../functions/_lib/verifier";
import {
  classifyCredential,
  refuseReplace,
  describeReplaceRefusal,
  parseReplaceArgs,
  type CredentialRow,
  type ReplaceArgs,
  type ReplaceRefusal,
} from "../src/lib/keypair-replacement";
import {
  blocksAfterReplacement,
  describeRefusal,
  type CompromisedKey,
} from "../src/lib/vault-rekey-plan";
import compromisedFile from "./compromised-public-keys.json";
import { jwkThumbprint } from "../src/lib/jwk-thumbprint";
import { loadOrgPublicKey, bytesToHex } from "./org-key";
import { d1, q } from "./d1-remote";
import { assess, loadVaults } from "./vault-rekey";
import { assertLiveWriteAllowed, resolveStore } from "./vault-sync";
import { checkFreshness } from "./vault-snapshot-check";
import { describeTarget } from "./target";
import { isMain } from "./is-main";

const SNAPSHOT_MAX_AGE_HOURS = 6;
const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const COMPROMISED = compromisedFile.keys as CompromisedKey[];

/** The ISO form already in `accounts.sessions_valid_from` on both stores: whole seconds, trailing Z. */
const stamp = (): string => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

// 20 chars from a 57-symbol alphabet ≈ 117 bits, with the characters that are read wrong out loud
// removed — these are handed over by a person to a person. Same alphabet as
// rotate-pilot-credentials.ts, deliberately: two operator commands printing differently shaped
// secrets for the same account is a way for the wrong one to be typed in.
function generateSecret(length = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) out += alphabet[randomInt(alphabet.length)];
  return out;
}

interface AccountState {
  entry: CompromisedKey;
  liveThumbprint: string | null;
  credentials: CredentialRow[];
  hasPasswordIdentity: boolean;
  vaults: { vaultId: string; rotatable: true | { why: string } }[];
  refusals: ReplaceRefusal[];
}

/**
 * Every vault this account holds an envelope on, with whether the DEK rotation would take it.
 *
 * Asked through scripts/vault-rekey.ts's own `assess` rather than re-derived here, so the two
 * commands cannot disagree about what is rotatable — a disagreement whose failure mode is this
 * command replacing a keypair the other one then declines to finish for.
 */
async function vaultsFor(accountId: string): Promise<{ vaultId: string; rotatable: true | { why: string } }[]> {
  const ids = await d1<{ vault_id: string }>(
    `SELECT vault_id FROM vault_envelopes WHERE principal_account_id = ${q(accountId)} ORDER BY vault_id`,
  );
  if (!ids.length) return [];
  const rows = await loadVaults({ apply: false, all: false, vaultIds: ids.map((r) => r.vault_id) });
  return Promise.all(
    rows.map(async (row) => {
      const blocks = blocksAfterReplacement((await assess(row)).refusals);
      return {
        vaultId: row.vault_id,
        rotatable: blocks.length ? { why: blocks.map(describeRefusal).join("; ") } : (true as const),
      };
    }),
  );
}

async function inspect(entry: CompromisedKey): Promise<AccountState> {
  const keys = await d1<{ public_key_jwk: string }>(
    `SELECT public_key_jwk FROM public_keys WHERE account_id = ${q(entry.accountId)}`,
  );
  const liveThumbprint = keys.length ? await jwkThumbprint(JSON.parse(keys[0].public_key_jwk) as JsonWebKey) : null;

  const creds = await d1<{ method: string; kdf_params: string }>(
    `SELECT method, kdf_params FROM credentials WHERE account_id = ${q(entry.accountId)} ORDER BY method`,
  );
  const credentials: CredentialRow[] = creds.map((c) => ({ method: c.method, kdfParams: c.kdf_params }));

  const idents = await d1<{ n: number }>(
    `SELECT count(*) AS n FROM identities WHERE account_id = ${q(entry.accountId)} AND method = 'password'`,
  );
  const vaults = await vaultsFor(entry.accountId);

  return {
    entry,
    liveThumbprint,
    credentials,
    hasPasswordIdentity: (idents[0]?.n ?? 0) > 0,
    vaults,
    refusals: refuseReplace({
      liveThumbprint,
      compromisedThumbprint: entry.thumbprint,
      credentials,
      hasPasswordIdentity: (idents[0]?.n ?? 0) > 0,
      vaults,
    }),
  };
}

function report(s: AccountState): void {
  const fates = s.credentials.map((c) => classifyCredential(c));
  const rewrap = fates.filter((f) => f.fate === "rewrap").map((f) => f.method);
  const drop = fates.filter((f) => f.fate === "drop");
  console.log(`\n${s.entry.accountId}  (${s.entry.role})`);
  console.log(`  live public key   ${s.liveThumbprint ?? "none"}`);
  console.log(`  published key     ${s.entry.thumbprint}`);
  console.log(`  re-wrap           ${rewrap.length ? rewrap.join(", ") : "nothing"}`);
  for (const d of drop) if (d.fate === "drop") console.log(`  DELETE ${d.method.padEnd(12)}${d.why}`);
  for (const v of s.vaults) {
    console.log(`  vault ${v.vaultId}  ${v.rotatable === true ? "rotatable" : `NOT ROTATABLE — ${v.rotatable.why}`}`);
  }
  if (s.refusals.length) for (const r of s.refusals) console.log(`  REFUSED: ${describeReplaceRefusal(r)}`);
  else console.log(`  → ready to replace`);
}

/**
 * Replaces one account's keypair and every credential that can carry it, in one atomic statement.
 *
 * The new private key is wrapped once per re-wrappable method, each under its own fresh secret and
 * its own fresh salt. `authHashSha256` lands in `kdf_params` beside them because that is where
 * auth/password/login.ts reads it back from; without it the holder's first sign-in fails on a
 * comparison against undefined, which is invisible until they try.
 */
async function replaceOne(s: AccountState): Promise<Record<string, string>> {
  const id = s.entry.accountId;
  const { publicKeyJwk, privateKey } = await generateAccountKeypair();
  const at = stamp();
  const secrets: Record<string, string> = {};
  const statements: string[] = [
    `INSERT OR REPLACE INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${q(id)}, ${q(JSON.stringify(publicKeyJwk))}, ${q(at)});`,
    // Every row, not only the droppable ones: the re-wrappable methods are re-inserted below under
    // new salts, and deleting first means a method that has since stopped being re-wrappable cannot
    // survive as a row wrapping a key no envelope references.
    `DELETE FROM credentials WHERE account_id = ${q(id)};`,
    `DELETE FROM identities WHERE account_id = ${q(id)} AND method != 'password';`,
  ];

  for (const row of s.credentials) {
    const fate = classifyCredential(row);
    if (fate.fate !== "rewrap") continue;
    const secret = generateSecret();
    const salt = new Uint8Array(randomBytes(SALT_LEN));
    const wrapped = await wrapPrivateKey(privateKey, await deriveKekFromPassword(secret, salt));
    const kdf = {
      salt: bytesToHex(salt),
      iterations: PBKDF2_ITERATIONS,
      authHashSha256: await sha256Base64Url(await deriveAuthHash(secret, salt)),
    };
    secrets[row.method] = secret;
    statements.push(
      `INSERT OR REPLACE INTO credentials (account_id, method, wrapped_private_key, kdf_params, created_at) ` +
        `VALUES (${q(id)}, ${q(row.method)}, X'${bytesToHex(wrapped)}', ${q(JSON.stringify(kdf))}, ${q(at)});`,
    );
  }

  // A live cookie outlives a keypair otherwise: requireSession checks this column, so without it the
  // holder keeps a session for an account whose record their browser can no longer decrypt.
  statements.push(`UPDATE accounts SET sessions_valid_from = ${q(at)} WHERE id = ${q(id)};`);

  await d1(statements.join("\n"));

  // Read back rather than trust the write. The failure this catches is a partially applied swap,
  // which the atomicity above is supposed to make impossible — so if it ever fires, the premise is
  // wrong and that is worth knowing before the next account.
  const after = await d1<{ public_key_jwk: string }>(
    `SELECT public_key_jwk FROM public_keys WHERE account_id = ${q(id)}`,
  );
  const landed = await jwkThumbprint(JSON.parse(after[0].public_key_jwk) as JsonWebKey);
  const expected = await jwkThumbprint(publicKeyJwk);
  if (landed !== expected) throw new Error(`${id}: public_keys holds ${landed}, expected ${expected}`);
  const methods = await d1<{ method: string }>(
    `SELECT method FROM credentials WHERE account_id = ${q(id)} ORDER BY method`,
  );
  const want = Object.keys(secrets).sort().join(",");
  const got = methods.map((m) => m.method).sort().join(",");
  if (want !== got) throw new Error(`${id}: credentials hold [${got}], expected [${want}]`);

  return secrets;
}

/**
 * Installs the org's new PUBLIC key, which is all D1 ever holds of it.
 *
 * The org is not an account: it has no credentials rows and nothing signs in as it. Its private half
 * is wrapped under ORG_KEY_PASSPHRASE in a file in the credential store, which is the asymmetry that
 * made this whole exposure recoverable — the published org key's private half was never usable
 * without a passphrase that was never published. So there is nothing to mint here: the new key
 * already exists, generated by `npm run org:key`, and this installs its public half.
 */
async function installOrgKey(apply: boolean): Promise<void> {
  const jwk = loadOrgPublicKey();
  const thumbprint = await jwkThumbprint(jwk);
  const published = COMPROMISED.find((c) => c.accountId === ORG_ACCOUNT_ID);
  const rows = await d1<{ public_key_jwk: string }>(
    `SELECT public_key_jwk FROM public_keys WHERE account_id = ${q(ORG_ACCOUNT_ID)}`,
  );
  const live = rows.length ? await jwkThumbprint(JSON.parse(rows[0].public_key_jwk) as JsonWebKey) : null;

  console.log(`\n${ORG_ACCOUNT_ID}  (org operational)`);
  console.log(`  live public key   ${live ?? "none"}`);
  console.log(`  key in store      ${thumbprint}`);

  // The one way to get this catastrophically wrong is to point ORG_KEY_PATH at the retired file and
  // install the published key back over the new one — which would read as success and undo the whole
  // phase. The rotation needs that file reachable, so the override exists and this is the guard.
  if (published && thumbprint === published.thumbprint) {
    throw new Error(
      `the org key at the resolved ORG_KEY_PATH is the PUBLISHED one (${thumbprint}) — ` +
        `installing it would undo the rotation. Point ORG_KEY_PATH at the new key, or unset it`,
    );
  }
  if (live === thumbprint) {
    console.log(`  → already installed`);
    return;
  }
  if (!apply) {
    console.log(`  → would install`);
    return;
  }
  const at = stamp();
  await d1(
    `INSERT OR REPLACE INTO public_keys (account_id, public_key_jwk, created_at) VALUES (${q(ORG_ACCOUNT_ID)}, ${q(JSON.stringify(jwk))}, ${q(at)});`,
  );
  const after = await d1<{ public_key_jwk: string }>(
    `SELECT public_key_jwk FROM public_keys WHERE account_id = ${q(ORG_ACCOUNT_ID)}`,
  );
  const landed = await jwkThumbprint(JSON.parse(after[0].public_key_jwk) as JsonWebKey);
  if (landed !== thumbprint) throw new Error(`org public_keys holds ${landed}, expected ${thumbprint}`);
  console.log(`  → installed`);
}

function selected(args: ReplaceArgs): CompromisedKey[] {
  const accounts = COMPROMISED.filter((c) => c.accountId !== ORG_ACCOUNT_ID);
  if (!args.accountIds.length) return accounts;
  const chosen = accounts.filter((c) => args.accountIds.includes(c.accountId.toLowerCase()));
  const missing = args.accountIds.filter((a) => !accounts.some((c) => c.accountId.toLowerCase() === a));
  if (missing.length) {
    throw new Error(
      `not a published account in scripts/compromised-public-keys.json: ${missing.join(", ")} — ` +
        `this command replaces only the keypairs recorded there`,
    );
  }
  return chosen;
}

async function main(): Promise<void> {
  const args = parseReplaceArgs(process.argv.slice(2));
  console.log(describeTarget());
  console.log(args.apply ? "\nmode: --apply (writes to D1)" : "\nmode: --check (writes nothing)");

  const store = resolveStore();
  if (args.apply) {
    assertLiveWriteAllowed(`replace the keypair of ${selected(args).length} account(s) in store "${store}"`);
    const fresh = await checkFreshness(SNAPSHOT_MAX_AGE_HOURS, new Date(), store);
    if (!fresh.ok) throw new Error(`refusing to write: ${fresh.reason}`);
    console.log(`snapshot ${fresh.snapshotId} is ${fresh.ageHours?.toFixed(1)}h old — recent enough`);
  }

  // The org first when it is in the run. The DEK rotation mints an org envelope to whatever
  // public_keys holds, so installing the new org key late would mean the rotation had already
  // wrapped a fresh DEK to the retired one.
  const wantOrg = args.org || args.all || !args.apply;
  if (wantOrg) await installOrgKey(args.apply);

  const states: AccountState[] = [];
  for (const entry of args.org && !args.all && !args.accountIds.length ? [] : selected(args)) {
    const s = await inspect(entry);
    states.push(s);
    report(s);
  }

  const blocked = states.filter((s) => s.refusals.length);
  const ready = states.filter((s) => !s.refusals.length);
  console.log(
    `\n${ready.length} account(s) ready to replace; ${blocked.length} blocked` +
      (states.length ? ` of ${states.length} in the published record` : ""),
  );

  if (!args.apply) {
    console.log("\nnothing was written. Re-run with --apply --all (or --account <uuid>) to replace.");
    process.exit(blocked.length ? 1 : 0);
  }
  if (blocked.length) {
    throw new Error(
      `refusing to replace any keypair while ${blocked.length} of ${states.length} account(s) are blocked — ` +
        `each refusal above is fixed by hand, out of band, and the ordering is what keeps the rotation honest`,
    );
  }

  const handover: { accountId: string; role: string; secrets: Record<string, string> }[] = [];
  for (const s of ready) {
    const secrets = await replaceOne(s);
    handover.push({ accountId: s.entry.accountId, role: s.entry.role, secrets });
    console.log(`replaced ${s.entry.accountId} — new ${Object.keys(secrets).join(", ")}`);
  }

  if (handover.length) {
    console.log(`\n${"=".repeat(72)}\nNEW SECRETS — printed once, stored nowhere. Hand over out of band.\n${"=".repeat(72)}`);
    for (const h of handover) {
      console.log(`\n${h.accountId}  (${h.role})`);
      for (const [method, secret] of Object.entries(h.secrets)) console.log(`  ${method.padEnd(10)}${secret}`);
    }
    console.log(
      `\n${"=".repeat(72)}\nEvery envelope these accounts hold is now wrapped to a key nobody has.\n` +
        `Run \`npm run vault:rekey -- --apply --all\` NEXT, in this same sitting, with ORG_KEY_PATH\n` +
        `pointed at the RETIRED org key so the old DEKs can still be opened. Until it has run, these\n` +
        `accounts cannot open their own records.\n${"=".repeat(72)}`,
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
