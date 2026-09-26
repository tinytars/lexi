// Seal every raw original a store is still holding in plaintext.
//
// WHY IT MATTERS. Uploaded originals are the most sensitive files a patient gives LexiTar, and until
// this migration they were the ones SECURITY.md's "encrypted client-side" claim did not cover. New
// uploads are sealed by the browser (src/lib/attachment-store.ts); this is the sweep for everything
// already in the bucket.
//
//   npm run raw:encrypt              # report only — reads bytes, writes nothing
//   npm run raw:encrypt -- --confirm # mint the keys, save them, and overwrite the objects
//
// Like every script here it targets THIS WORKTREE's environment (scripts/target.ts), so it runs once
// per environment: from a `dev` checkout for health-identity-dev, from a `main` one for prod.
//
// TWO NAMESPACES IT REFUSES, and both refusals are the point:
//   - An ORPHANED namespace, owned by no account. functions/_lib/raw-owner.ts's `mayWrite` never
//     admits one, and this must not be the one writer that does — an orphan's bytes are claimable by
//     the patient who proves ownership (functions/api/raw/claim.ts), and sealing them under a key in
//     nobody's vault would end that.
//   - An account that has REVOKED org recovery. There is no key to reach and no --force; the
//     browser's own sweep (src/lib/raw-seal-heal.ts) is the only lane for those, which is the setting
//     working rather than a gap.
//
// THE KEY IS SAVED BEFORE THE CIPHERTEXT EXISTS, and the vault is read back to prove it landed. A
// sealed object whose key was never saved is unopenable, and because the corpus reads every
// `raw_objects` row under a namespace, one of them refuses that patient's every question — a loss no
// later sweep can undo. The reverse, a key saved for an object that never got sealed, costs nothing.
//
// THE WINDOW THIS CANNOT CLOSE: the vault write has no compare-and-swap (scripts/vault-ops.ts), so a
// browser that loaded the vault before this run and saves after it drops the keys this run added.
// The post-write read-back catches it while the run is still going; run it when the store is quiet.

import "./load-creds";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, assertLiveWriteAllowed, getObject, putObject, resolveStore } from "./vault-sync";
import { openVaultFor, ownerOf, parseRawKey } from "./raw-cipher-cli";
import { flushOrgKeyUses } from "./access-log";
import { encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";
import { isSealed, sealRaw } from "../src/lib/raw-cipher";
import { bytesToBase64 } from "../src/lib/base64";
import { isMain } from "./is-main";
import type { Vault } from "../src/lib/types";

const STORE = resolveStore();

interface Pending {
  r2Key: string;
  /** The key ring entry, which a sidecar shares with the document it transcribes. */
  file: string;
  plain: Uint8Array;
}

interface Counts {
  sealed: number;
  already: number;
  missing: number;
  orphaned: number;
  unreachable: number;
}

/** `{store}/raw/{slug}/…` and `{store}/text/{slug}/….json`, grouped by the namespace they share. */
export function groupBySlug(keys: string[]): Map<string, string[]> {
  const bySlug = new Map<string, string[]>();
  for (const r2Key of keys) {
    const parsed = parseRawKey(r2Key);
    if (!parsed) continue;
    bySlug.set(parsed.slug, [...(bySlug.get(parsed.slug) ?? []), r2Key]);
  }
  return bySlug;
}

const newContentKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

/** The vault with these keys added, without disturbing any other namespace's ring. */
export function withKeys(vault: Vault, slug: string, keys: Record<string, string>): Vault {
  return { ...vault, rawKeys: { ...vault.rawKeys, [slug]: { ...vault.rawKeys?.[slug], ...keys } } };
}

async function saveAndVerify(open: { vault: Vault; dek: CryptoKey; r2Key: string }, expect: Record<string, string>, slug: string): Promise<void> {
  await putObject(LIVE_BUCKET, open.r2Key, await encryptVaultV2(open.vault, open.dek));
  const back = await getObject(LIVE_BUCKET, open.r2Key);
  if (!back) throw new Error(`wrote ${open.r2Key} but it reads back missing`);
  const ring = (await decryptVaultV2<Vault>(back, open.dek)).rawKeys?.[slug] ?? {};
  const lost = Object.keys(expect).filter((f) => ring[f] !== expect[f]);
  // Loud and fatal: the next step seals objects under these keys, and a key that did not land would
  // make those objects unopenable forever.
  if (lost.length) throw new Error(`verify failed for ${open.r2Key}: ${lost.length} key(s) missing after the write (${lost[0]})`);
}

async function sweepNamespace(slug: string, keys: string[], confirm: boolean, counts: Counts, say: (line: string) => void): Promise<void> {
  const owner = await ownerOf(STORE, slug);
  if (!owner) {
    counts.orphaned += 1;
    say(`  ~ ${slug}: orphaned — left plaintext so it stays claimable (raw/claim.ts)`);
    return;
  }
  const open = await openVaultFor(STORE, owner);
  if (!open) {
    counts.unreachable += 1;
    say(`  ~ ${slug}: org recovery revoked or no vault — only the owner's browser can seal these`);
    return;
  }

  const pending: Pending[] = [];
  const minted: Record<string, string> = {};
  const ring = { ...open.vault.rawKeys?.[slug] };
  for (const r2Key of keys) {
    // Every key here came through groupBySlug, which only yields keys parseRawKey accepted.
    const stored = await getObject(LIVE_BUCKET, r2Key);
    if (!stored) {
      counts.missing += 1;
      say(`  ! ${r2Key}: a raw_objects row with no object`);
      continue;
    }
    if (isSealed(stored)) {
      counts.already += 1;
      continue;
    }
    const { file } = parseRawKey(r2Key) ?? { file: "" };
    // A document and its transcription sidecar share ONE content key, so a sidecar found after its
    // document has already been given one reuses it rather than minting a second.
    minted[file] ??= ring[file] ?? newContentKey();
    pending.push({ r2Key, file, plain: stored });
  }
  if (pending.length === 0) return;

  if (!confirm) {
    counts.sealed += pending.length;
    for (const { r2Key } of pending) say(`  · ${r2Key}: would be sealed`);
    return;
  }

  await saveAndVerify({ ...open, vault: withKeys(open.vault, slug, minted) }, minted, slug);
  for (const { r2Key, file, plain } of pending) {
    await putObject(LIVE_BUCKET, r2Key, await sealRaw(plain, minted[file]));
    counts.sealed += 1;
  }
  // The window the header names: a browser save landing between the two writes above drops these
  // keys, and the objects are already ciphertext by then. Re-read the vault as it now stands and
  // write the keys onto THAT, so a concurrent edit is merged with rather than overwritten.
  const latest = await openVaultFor(STORE, owner, true);
  if (!latest) throw new Error(`${slug}: sealed ${pending.length} object(s) but the vault can no longer be opened to confirm their keys`);
  await saveAndVerify({ ...latest, vault: withKeys(latest.vault, slug, minted) }, minted, slug);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  if (confirm) assertLiveWriteAllowed(`every plaintext raw original in store "${STORE}"`);

  const rows = await d1<{ r2_key: string }>(
    `SELECT r2_key FROM raw_objects WHERE r2_key LIKE ${q(`${STORE}/raw/%`)} OR r2_key LIKE ${q(`${STORE}/text/%`)} ORDER BY r2_key`,
  );
  const bySlug = groupBySlug(rows.map((r) => r.r2_key));
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")`);
  say(`Recorded objects: ${rows.length} across ${bySlug.size} namespace(s)\n`);

  const counts: Counts = { sealed: 0, already: 0, missing: 0, orphaned: 0, unreachable: 0 };
  for (const [slug, keys] of bySlug) await sweepNamespace(slug, keys, confirm, counts, say);

  say(
    `\n${confirm ? "Sealed" : "Would seal"}: ${counts.sealed}   already sealed: ${counts.already}   ` +
      `missing: ${counts.missing}   orphaned namespaces: ${counts.orphaned}   unreachable namespaces: ${counts.unreachable}`,
  );
  if (!confirm && counts.sealed > 0) say(`\nReport only. Re-run with --confirm to seal ${counts.sealed} object(s).`);
}

if (isMain(import.meta.url)) {
  // The flush runs on both exits: an org-key decrypt that happened must be logged even when the run
  // then fails (scripts/access-log.ts).
  main()
    .then(() => flushOrgKeyUses())
    .catch(async (e) => {
      await flushOrgKeyUses().catch(() => undefined);
      process.stderr.write(`\n${(e as Error).message}\n`);
      process.exit(1);
    });
}
