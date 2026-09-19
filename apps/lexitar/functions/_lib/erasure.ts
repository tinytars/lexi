// W72 (docs/cross-app/15 items 17+18) — erase an account and everything under it.
//
// There was no such route. `DELETE /api/account/methods` removes one login credential and nothing
// else, so a patient asking to have their data deleted could not be told yes. That is a DPGA
// Indicator 7/9A gap and, more plainly, a promise the application was making implicitly and could not
// keep.
//
// THE HARD PART IS NOT DELETING — IT IS KNOWING WHAT TO DELETE. An erasure that misses a class of
// object is worse than no erasure, because the subject is told their data is gone. So this module
// does not carry a hand-written list of things to clean up. It builds a PLAN from the same
// authorities the writers use, and `tests/unit/erasure-completeness.test.ts` derives the set of R2
// key classes from `storeKey()`'s real call sites in `functions/` — the same technique
// `store-key-classes.test.ts` uses, and for the same reason: a hand-listed expectation agrees with
// the implementation by construction and would keep passing forever after a new class appeared.
//
// WHAT IT CANNOT ERASE, STATED RATHER THAN HIDDEN: objects under `raw/` and `text/` written before
// migration 0008 have no ownership record, because their key carries a display name that exists only
// inside the encrypted vault (SECURITY.md gap 1) — and objects in this patient's namespace that
// another account claimed by writing them first. The plan reports those as `unattributable` instead
// of silently omitting them, the route returns the count, and an erasure that leaves any is recorded
// as incomplete. An operator with vault access can finish the job offline; nobody is told the data is
// gone when it is not.
//
// ORDER MATTERS. R2 first, then D1, then the tombstone. A crash midway must never leave a live D1 row
// pointing at a deleted blob (which reads as corruption) or, worse, an account that is gone while its
// PHI is not. Deleting the payload before the pointer means the worst interruption leaves rows that
// point at nothing — recoverable, re-runnable, and visible.

import type { D1Database } from "./identity-types";
import { revokeSessions, tombstoneAccount } from "./identity-accounts";
import { listEnvelopesForPrincipal, listVaultsForOwner, type VaultRow } from "./identity-vault";
import { listPatientsForProvider, listProvidersForPatient } from "./identity-providers";
import { deleteRawObjectsForAccount, listRawObjectsForAccount } from "./identity-audit";
import { storeKey, type StoreEnv } from "./store";
import { listAllKeys, type ObjectBucket } from "./object-bucket";
import { vaultIdFromR2Key } from "../../src/lib/client-id";

export type ErasableBucket = Pick<ObjectBucket, "delete" | "list">;

export interface ErasureEnv extends StoreEnv {
  DB: D1Database;
  VAULT: ErasableBucket;
}

export interface ErasureReport {
  accountId: string;
  at: string;
  /** R2 keys deleted, sorted. */
  r2Deleted: string[];
  /**
   * Raw/text objects that sit in THIS account's namespaces and that the erasure did not delete —
   * either pre-0008 objects with no ownership record, or objects a different account (a clinician)
   * claimed by writing them first. Either way the server cannot prove they are this account's to
   * delete. Non-zero means the erasure is INCOMPLETE and must be said so.
   */
  unattributable: number;
  vaultsErased: string[];
  complete: boolean;
}

/** `vaults.r2Key` is `data-{slug}.enc`; the chat blob for the same vault is `chat-{slug}.enc`. */
export function chatKeyForVault(env: StoreEnv, vault: VaultRow): string | null {
  const id = vaultIdFromR2Key(vault.r2Key);
  return id ? storeKey(env, `chat-${id}.enc`) : null;
}

/**
 * Every R2 key this account's PHI occupies, as far as the server can attribute it.
 *
 * Vault blobs and chat history are derived from `vaults` rows, which the server owns outright. Raw
 * originals and their extracted-text sidecars come from `raw_objects`, which only exists from
 * migration 0008 onward — see the module header.
 */
export async function r2KeysForAccount(env: ErasureEnv, accountId: string): Promise<{ keys: string[]; vaults: VaultRow[] }> {
  const vaults = await listVaultsForOwner(env.DB, accountId);
  const keys = new Set<string>();
  for (const v of vaults) {
    keys.add(storeKey(env, v.r2Key));
    const chat = chatKeyForVault(env, v);
    if (chat) keys.add(chat);
  }
  for (const key of await listRawObjectsForAccount(env.DB, accountId)) keys.add(key);
  return { keys: [...keys].sort(), vaults };
}

/**
 * The `raw/`/`text/` namespace segments this account's PHI occupies.
 *
 * Both prefixes are keyed `{store}/{raw|text}/{clientKey}/…`, where `clientKey` is derived from a
 * client name that lives inside the encrypted vault — the server cannot enumerate it, only recognise
 * it from keys it already attributes to the account. Vault slugs are included because a vault blob is
 * `data-{slug}.enc` and the same slug is the natural namespace for that client's originals.
 */
function namespacesForAccount(env: StoreEnv, keys: string[], vaults: VaultRow[]): Set<string> {
  const namespaces = new Set<string>();
  for (const prefix of ["raw", "text"]) {
    const root = storeKey(env, prefix) + "/";
    for (const key of keys) {
      if (!key.startsWith(root)) continue;
      const ns = key.slice(root.length).split("/")[0];
      if (ns) namespaces.add(ns);
    }
  }
  for (const v of vaults) {
    const id = vaultIdFromR2Key(v.r2Key);
    if (id) namespaces.add(id);
  }
  return namespaces;
}

/**
 * Deletes everything attributable to `accountId` and tombstones the account.
 *
 * Not wrapped in a D1 batch: R2 deletes cannot participate in a D1 transaction, so an all-or-nothing
 * claim would be false. Instead every step is idempotent and the whole thing is safe to re-run —
 * which is the only honest atomicity available here, and better than a transaction that covers half
 * the work and implies it covers all of it.
 */
export async function eraseAccount(env: ErasureEnv, accountId: string, now: Date = new Date()): Promise<ErasureReport> {
  const at = now.toISOString();
  const { keys, vaults } = await r2KeysForAccount(env, accountId);

  // W75 — the count that decides `complete` is scoped to THIS account's namespaces.
  //
  // It used to be every key under `raw/`/`text/` with no row in `raw_objects`, store-wide, which is
  // wrong in both directions. Too wide: another patient's pre-0008 originals made this erasure report
  // incomplete, for objects this erasure was never going to touch. Too narrow, and much worse:
  // ownership is first-writer-wins, so a PDF a CLINICIAN uploaded about this patient carries the
  // clinician's owner row. It is attributable, so it was not counted; it is not this account's, so it
  // was not deleted — and the subject was told `complete: true` while their PHI sat in the bucket.
  //
  // So: take the namespaces this account's own keys occupy, list them, and count everything the
  // erasure did not delete, owned or not. COUNTED, NEVER DELETED — deleting by prefix would destroy
  // another patient's only copy the moment two accounts shared a client display name (the collision
  // SECURITY.md gap 1 describes), which is also why a shared namespace reports incomplete here.
  const deleted = new Set(keys);
  const namespaces = namespacesForAccount(env, keys, vaults);
  let unattributable = 0;
  for (const prefix of ["raw", "text"]) {
    const root = storeKey(env, prefix) + "/";
    for (const ns of namespaces) {
      for (const k of await listAllKeys(env.VAULT, root + ns + "/")) {
        if (!deleted.has(k)) unattributable += 1;
      }
    }
  }

  for (const key of keys) await env.VAULT.delete(key);

  // Grants in both directions. A provider's own erasure must revoke the links THEY hold, or a patient
  // is left with an active grant to an account that no longer exists.
  const links = [
    ...(await listProvidersForPatient(env.DB, accountId)),
    ...(await listPatientsForProvider(env.DB, accountId)),
  ];
  for (const link of links) {
    await env.DB.prepare("DELETE FROM provider_links WHERE id = ?").bind(link.id).run();
  }
  // Envelopes this account holds on OTHER people's vaults — not covered by the owner-scoped delete
  // above, and the thing that would otherwise leave a dangling key-wrapping to a dead principal.
  for (const e of await listEnvelopesForPrincipal(env.DB, accountId)) {
    await env.DB.prepare("DELETE FROM vault_envelopes WHERE vault_id = ? AND principal_account_id = ?").bind(e.vaultId, accountId).run();
  }
  await env.DB.prepare("DELETE FROM vault_envelopes WHERE vault_id IN (SELECT vault_id FROM vaults WHERE owner_account_id = ?)").bind(accountId).run();
  await env.DB.prepare("DELETE FROM vaults WHERE owner_account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM credentials WHERE account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM identities WHERE account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM public_keys WHERE account_id = ?").bind(accountId).run();
  await env.DB.prepare("DELETE FROM crm_events WHERE account_id = ?").bind(accountId).run();
  await deleteRawObjectsForAccount(env.DB, accountId);
  // W73 — a live grant holds the vault's DEK wrapped under a recovery code. Leaving it behind would
  // leave a key to a record that has just been erased, which is the one thing an erasure route may not
  // do. Found by erasure-completeness.test.ts's D1 sweep the moment that sweep existed, having been
  // missed when the table was added a phase earlier.
  await env.DB.prepare("DELETE FROM recovery_grants WHERE account_id = ?").bind(accountId).run();

  // phi_access_events is deliberately NOT deleted. It records who read WHOSE record; the rows naming
  // this account as subject are the evidence a different principal's access happened, and the rows
  // naming it as actor are another patient's audit trail. They carry no content — an id, an action, a
  // timestamp — and the account they point at is now an opaque tombstone.

  // Before the tombstone, so a session cannot be used against a half-erased account.
  await revokeSessions(env.DB, accountId);
  await tombstoneAccount(env.DB, accountId, at);

  return {
    accountId,
    at,
    r2Deleted: keys,
    unattributable,
    vaultsErased: vaults.map((v) => v.vaultId),
    complete: unattributable === 0,
  };
}
