// The operator's side of raw-cipher.ts: opening a sealed stored original from a Node script.
//
// A raw object is AES-GCM ciphertext under a per-file content key that exists only inside the
// patient's encrypted vault (src/lib/raw-cipher.ts). The browser holds that vault open and reads the
// key directly. A script does not, so it walks the one path the estate already has to a vault it does
// not own: the ORG RECOVERY ENVELOPE — `loadOrgPrivateKey` → `unwrapDEKWithPrivateKey` →
// `decryptVaultV2` → `Vault.rawKeys`, exactly as scripts/recovery-approve.ts does for a locked-out
// patient.
//
// SO EVERY SCRIPT THAT READS RAW BYTES NOW NEEDS ORG_KEY_PASSPHRASE — but only when it meets a sealed
// object. A store still holding plaintext is read without the key ever being loaded, which is what
// keeps `npm run raw:pages` runnable during the migration and on a store that has none.
//
// TWO THINGS THIS CANNOT DO, BY DESIGN. A patient who revoked org recovery has no envelope, so their
// files are unreachable from here — that is the setting working, and the browser self-heal is the
// only lane that reaches them. And a vault written before the keyring existed simply has no key for
// a file, which reads as "still plaintext" and is true.
//
// Every unwrap is audited: callers pass through `openStored` and finish with `flushOrgKeyUses()`,
// which writes the `org_key_decrypt` row (scripts/access-log.ts). A decrypt that is not logged is the
// failure mode that file exists to close.

import { d1, q } from "./d1-remote";
import { LIVE_BUCKET, getObject, resolveStore } from "./vault-sync";
import { loadOrgPrivateKey } from "./org-key";
import { recordOrgKeyUse } from "./access-log";
import { decryptVaultV2, unwrapDEKWithPrivateKey } from "@tinytars/vault/crypto";
import { openRaw, isSealed } from "../src/lib/raw-cipher";
import { ORG_ACCOUNT_ID } from "../functions/_lib/org";
import type { Vault } from "../src/lib/types";

/** `{store}/raw/{slug}/{file}`, or the `{store}/text/{slug}/{file}.json` sidecar sealed under the
 *  SAME content key as the document it transcribes — so both resolve to one lookup. */
export function parseRawKey(r2Key: string): { slug: string; file: string } | null {
  const m = /^[^/]+\/(raw|text)\/([^/]+)\/(.+)$/.exec(r2Key);
  if (!m) return null;
  const [, kind, slug, tail] = m;
  return { slug, file: kind === "text" ? tail.replace(/\.json$/, "") : tail };
}

/** One patient's vault, open: enough to read its key ring and to write a new key into it. */
export interface OpenVault {
  vault: Vault;
  dek: CryptoKey;
  /** The blob's key in the live bucket, store prefix included. */
  r2Key: string;
}

// Both caches are per-run and per-account, which is what keeps a store-wide sweep to one org-key
// unwrap and one vault fetch per patient rather than one per file.
const ownerBySlug = new Map<string, string | null>();
const vaultByAccount = new Map<string, OpenVault | null>();
let orgKey: CryptoKey | undefined;

export async function ownerOf(store: string, slug: string): Promise<string | null> {
  const hit = ownerBySlug.get(slug);
  if (hit !== undefined) return hit;
  // The namespace's owner, resolved the way functions/_lib/raw-owner.ts resolves it — by PREFIX and
  // oldest row first — so a key with no row of its own still finds the account that holds its keyring.
  const [row] = await d1<{ account_id: string }>(
    `SELECT account_id FROM raw_objects WHERE r2_key LIKE ${q(`${store}/raw/${slug}/%`)} OR r2_key LIKE ${q(`${store}/text/${slug}/%`)} ORDER BY created_at LIMIT 1`,
  );
  const owner = row?.account_id ?? null;
  ownerBySlug.set(slug, owner);
  return owner;
}

/**
 * One account's vault, opened through the org recovery envelope, or null when nothing here can.
 *
 * Cached per run, and `refresh` is how the sealing sweep re-reads a vault it has just written: the
 * write has no compare-and-swap (scripts/vault-ops.ts), so confirming a key landed means reading it
 * back rather than trusting the PUT.
 */
export async function openVaultFor(store: string, accountId: string, refresh = false): Promise<OpenVault | null> {
  const hit = vaultByAccount.get(accountId);
  if (hit !== undefined && !refresh) return hit;

  const [row] = await d1<{ vault_id: string; r2_key: string; org_recovery_revoked_at: string | null }>(
    `SELECT vault_id, r2_key, org_recovery_revoked_at FROM vaults WHERE owner_account_id = ${q(accountId)}`,
  );
  // Revocation is absolute here for the same reason it is in recovery-approve.ts: it is the one lever
  // a patient has to say "not even the operator", and there is no --force.
  if (!row || row.org_recovery_revoked_at) {
    vaultByAccount.set(accountId, null);
    return null;
  }

  const [envelope] = await d1<{ wrapped_dek: string; ephemeral_public_key_jwk: string }>(
    `SELECT hex(wrapped_dek) AS wrapped_dek, ephemeral_public_key_jwk FROM vault_envelopes WHERE vault_id = ${q(row.vault_id)} AND principal_account_id = ${q(ORG_ACCOUNT_ID)}`,
  );
  const r2Key = `${store}/${row.r2_key}`;
  const blob = await getObject(LIVE_BUCKET, r2Key);
  if (!envelope || !blob) {
    vaultByAccount.set(accountId, null);
    return null;
  }

  orgKey ??= await loadOrgPrivateKey();
  const dek = await unwrapDEKWithPrivateKey(
    Uint8Array.from(Buffer.from(envelope.wrapped_dek, "hex")),
    JSON.parse(envelope.ephemeral_public_key_jwk) as JsonWebKey,
    orgKey,
  );
  // The audited identifier is the vault's own r2_key stem, which migration 0011 made the account id —
  // access-log.ts looks the vault up by `data-{id}.enc` and would find nothing for a client slug.
  recordOrgKeyUse({ clientId: row.r2_key.replace(/^data-/, "").replace(/\.enc$/, ""), purpose: "raw:open" });

  const open: OpenVault = { vault: await decryptVaultV2<Vault>(blob, dek), dek, r2Key };
  vaultByAccount.set(accountId, open);
  return open;
}

/** One account's whole key ring, or an empty one when nothing here can open their vault. */
async function keyringFor(store: string, accountId: string): Promise<Record<string, Record<string, string>>> {
  return (await openVaultFor(store, accountId))?.vault.rawKeys ?? {};
}

/** The content key for one stored object, or undefined when nothing here can produce it. */
export async function contentKeyFor(r2Key: string, store = resolveStore()): Promise<string | undefined> {
  const parsed = parseRawKey(r2Key);
  if (!parsed) return undefined;
  const owner = await ownerOf(store, parsed.slug);
  if (!owner) return undefined;
  return (await keyringFor(store, owner))[parsed.slug]?.[parsed.file];
}

/**
 * The PLAINTEXT of one stored object: passed through when it is plaintext already, opened when it is
 * sealed and this run can reach the key. Throws `RawKeyError` when it is sealed and cannot — a caller
 * that would rather skip the file than fail the run catches it and says so.
 */
export async function openStored(r2Key: string, stored: Uint8Array, store = resolveStore()): Promise<Uint8Array> {
  if (!isSealed(stored)) return stored;
  return openRaw(stored, r2Key, await contentKeyFor(r2Key, store));
}

/** Fetch and open in one step, since every caller does both. Null when there is no such object. */
export async function getStored(r2Key: string, store = resolveStore()): Promise<Uint8Array | null> {
  const stored = await getObject(LIVE_BUCKET, r2Key);
  return stored && openStored(r2Key, stored, store);
}
