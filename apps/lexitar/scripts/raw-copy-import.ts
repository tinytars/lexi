// Seal a staged export (raw-copy-export.ts) into THIS store's own key ring and record the objects.
//
//   npm run raw:copy-import -- <staging dir>              # report only — writes nothing
//   PLOVER_ALLOW_LOCAL_VAULT_WRITE=1 \
//     npm run raw:copy-import -- <staging dir> --confirm   # mint keys, seal, PUT, record
//
// WHAT IT WILL AND WILL NOT COPY. Only a file THIS store's record already names and this bucket does
// not hold. A file the record does not name would be bytes nothing here ever fetches; a file already
// present is left exactly as it is, because an attachment key is content-addressed and the copy
// already there is already the right bytes. scripts/raw-copy-plan.ts holds the four sets and the
// argument for each, and is the part a test can reach.
//
// IMAGES ONLY, which is a property of the export rather than a check here: a PDF carries a
// `?pages=` count measured by pdf.js in a browser (src/lib/attachment-store.ts), and this lane has
// no way to produce one, so a PDF copied here would arrive unmeasured and strand the corpus
// (scripts/raw-pages-backfill.ts is the repair, and needing it is not an improvement).
//
// THE KEY IS SAVED BEFORE THE CIPHERTEXT EXISTS and the vault is read back to prove it landed, which
// is scripts/raw-encrypt-backfill.ts's rule and for its reason: a sealed object whose key never
// landed is unopenable, and because the corpus reads every recorded object under a namespace, one of
// them refuses that patient's every question. The reverse — a key for an object that never arrived —
// costs nothing.
//
// THE WINDOW THIS CANNOT CLOSE: the vault write has no compare-and-swap (scripts/vault-ops.ts), so a
// browser that loaded this vault before the run and saves after it drops the keys this run added.
// The record must be closed everywhere, which is also what PLOVER_ALLOW_LOCAL_VAULT_WRITE is the
// operator asserting. The post-write re-read catches it while the run is still going.
//
// A FAILED RUN IS RESUMABLE, and that is not a nicety. Rows are recorded per namespace, after its
// objects, so a namespace that throws leaves only its own objects unrecorded — and `heal` picks
// exactly those up on the next run, because `take` excludes anything already present and nothing
// else ever would. Every insert is INSERT OR IGNORE, so a re-run is a no-op.
import "./load-creds";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, assertLiveWriteAllowed, getObject, listObjects, putObject, resolveStore } from "./vault-sync";
import { keyringOwnerOf, openVaultFor } from "./raw-cipher-cli";
import { assertTargetConsistent } from "./target";
import { collectAttachments } from "./record-export";
import { flushOrgKeyUses } from "./access-log";
import { encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";
import { sealRaw } from "../src/lib/raw-cipher";
import { bytesToBase64 } from "../src/lib/base64";
import { isMain } from "./is-main";
import { MANIFEST, groupBySlug, type StagedEntry } from "./raw-copy-manifest";
import { planNamespace } from "./raw-copy-plan";
import type { Vault } from "../src/lib/types";

const newContentKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

export function withKeys(vault: Vault, slug: string, keys: Record<string, string>): Vault {
  return { ...vault, rawKeys: { ...vault.rawKeys, [slug]: { ...vault.rawKeys?.[slug], ...keys } } };
}

type OpenVault = { vault: Vault; dek: CryptoKey; r2Key: string };

async function saveAndVerify(open: OpenVault, expect: Record<string, string>, slug: string): Promise<void> {
  await putObject(LIVE_BUCKET, open.r2Key, await encryptVaultV2(open.vault, open.dek));
  const back = await getObject(LIVE_BUCKET, open.r2Key);
  if (!back) throw new Error(`wrote ${open.r2Key} but it reads back missing`);
  const ring = (await decryptVaultV2<Vault>(back, open.dek)).rawKeys?.[slug] ?? {};
  const lost = Object.keys(expect).filter((file) => ring[file] !== expect[file]);
  if (lost.length) throw new Error(`verify failed for ${open.r2Key}: ${lost.length} key(s) missing after the write`);
}

/** INSERT OR IGNORE, so a re-run is a no-op and a partial run is safe to resume. */
async function recordRows(rows: Array<[string, string]>): Promise<number> {
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const values = rows
      .slice(i, i + CHUNK)
      .map(([key, account]) => `(${q(key)}, ${q(account)}, ${q(new Date().toISOString())})`)
      .join(", ");
    await d1(`INSERT OR IGNORE INTO raw_objects (r2_key, account_id, created_at) VALUES ${values}`);
  }
  return rows.length;
}

export async function main(): Promise<void> {
  assertTargetConsistent();
  const store = resolveStore();
  const confirm = process.argv.includes("--confirm");
  const dir = process.argv.slice(2).find((a) => a.startsWith("/"));
  if (!dir) throw new Error("pass the staging directory raw-copy-export printed, as an absolute path");
  const manifest: StagedEntry[] = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  if (confirm) assertLiveWriteAllowed(`staged image originals into store "${store}"`);

  const bySlug = groupBySlug(manifest);
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`target: db=${D1} bucket=${LIVE_BUCKET} store="${store}"`);
  say(`staged: ${manifest.length} image(s) across ${bySlug.size} namespace(s)\n`);
  say(`namespace                                 staged  named  present   gap  TO COPY  ROWS-ONLY  hash-odd`);

  let copied = 0;
  let recorded = 0;
  for (const [slug, entries] of bySlug) {
    const owner = await keyringOwnerOf(store, slug);
    const open = owner ? await openVaultFor(store, owner) : null;
    if (!open) {
      say(`${slug.padEnd(40)} ${String(entries.length).padStart(6)}   — no vault this lane can open, skipped`);
      continue;
    }
    // NOT named `record`: a local of that name here shadows recordRows' caller scope badly enough
    // that a 2026-11-09 run wrote 22 objects and then threw on the row insert, leaving them
    // invisible in a store whose listing route answers from rows. `heal` is what recovered them.
    const clientRecord = open.vault.clients?.[slug];
    const named = new Set(clientRecord ? collectAttachments(clientRecord).keys() : []);
    const prefix = `${store}/raw/${slug}/`;
    const present = new Set((await listObjects(LIVE_BUCKET, prefix)).map((o) => o.key.slice(prefix.length)));
    const rowed = new Set(
      (await d1<{ r2_key: string }>(`SELECT r2_key FROM raw_objects WHERE r2_key LIKE ${q(prefix)} || '%'`)).map((r) =>
        r.r2_key.slice(prefix.length),
      ),
    );
    const keyed = new Set(Object.keys(open.vault.rawKeys?.[slug] ?? {}));
    const plan = planNamespace({ entries, named, present, rowed, keyed });
    say(
      `${slug.padEnd(40)} ${String(entries.length).padStart(6)} ${String(named.size).padStart(6)}` +
        ` ${String(present.size).padStart(8)} ${String(plan.gap.length).padStart(5)} ${String(plan.take.length).padStart(8)}` +
        ` ${String(plan.heal.length).padStart(9)} ${String(plan.odd.length).padStart(8)}`,
    );
    if ((plan.take.length === 0 && plan.heal.length === 0) || !confirm) {
      copied += plan.take.length;
      continue;
    }

    // The rows-only set first: it needs no key and no write, so it lands even if the copy throws.
    let rows = await recordRows(plan.heal.map((e) => [`${prefix}${e.file}`, owner!] as [string, string]));
    recorded += rows;

    if (plan.take.length) {
      const ring = { ...open.vault.rawKeys?.[slug] };
      const minted: Record<string, string> = {};
      for (const e of plan.take) minted[e.file] ??= ring[e.file] ?? newContentKey();
      await saveAndVerify({ ...open, vault: withKeys(open.vault, slug, minted) }, minted, slug);

      const fresh: Array<[string, string]> = [];
      for (const e of plan.take) {
        const plain = new Uint8Array(readFileSync(join(dir, e.local)));
        await putObject(LIVE_BUCKET, `${prefix}${e.file}`, await sealRaw(plain, minted[e.file]));
        fresh.push([`${prefix}${e.file}`, owner!]);
        if (e.sidecar) {
          const side = new Uint8Array(readFileSync(join(dir, e.sidecar)));
          await putObject(LIVE_BUCKET, `${store}/text/${slug}/${e.file}.json`, await sealRaw(side, minted[e.file]));
          fresh.push([`${store}/text/${slug}/${e.file}.json`, owner!]);
        }
        copied += 1;
      }
      // Re-read and save again: a browser save landing between the key write and the objects would
      // have dropped these keys, and the objects are ciphertext by then.
      const latest = await openVaultFor(store, owner!, true);
      if (!latest) {
        throw new Error(`${slug}: wrote ${plan.take.length} object(s) but the vault can no longer be opened to confirm their keys`);
      }
      await saveAndVerify({ ...latest, vault: withKeys(latest.vault, slug, minted) }, minted, slug);
      const n = await recordRows(fresh);
      recorded += n;
      rows += n;
    }
    say(`  ${slug}: copied ${plan.take.length}, recorded ${rows} row(s) (${plan.heal.length} rows-only)`);
  }

  say(
    confirm
      ? `\ncopied ${copied} image(s) and recorded ${recorded} row(s) into store "${store}".`
      : `\nReport only — nothing was written. ${copied} image(s) would be copied; re-run with --confirm.`,
  );
}

if (isMain(import.meta.url)) {
  main()
    .then(() => flushOrgKeyUses())
    .catch(async (e) => {
      await flushOrgKeyUses().catch(() => undefined);
      process.stderr.write(`\n${(e as Error).message}\n`);
      process.exit(1);
    });
}
