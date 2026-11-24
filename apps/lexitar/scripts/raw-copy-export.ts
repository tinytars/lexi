// Stage one store's raw image originals as plaintext on this workstation, for raw-copy-import.ts to
// seal into another store's own key ring.
//
//   npm run raw:copy-export     # from a checkout bound to the SOURCE store
//   npm run raw:copy-purge      # delete every staging directory when the copy is done
//
// That last one is scripts/record-export.ts's own `--purge` under a second name, because both
// write into the same export root (scripts/export-dir.ts) and one sweep is the only kind that
// cannot leave the other's plaintext behind. The alias exists so the command is reachable from
// the name of the thing that staged the files.
//
// This half never writes to any store: one bucket listing, one vault open per namespace, one GET per
// object, and files under $XDG_STATE_HOME. scripts/raw-copy-manifest.ts says why plaintext on disk
// is the only copy that works and what it costs; read it before running this.
//
// IT REFUSES THE PRODUCTION STORE as a source. Not because reading prod is unsafe, but because a
// copy has a direction and the expensive mistake is running the halves in the wrong order against
// the wrong bindings — a prod export staged over a dev one, then imported back into prod, would
// re-seal production's own files under fresh keys for no reason. Override with
// LEXI_COPY_SOURCE_STORE=<store> if a prod-to-elsewhere copy is ever genuinely wanted.
import "./load-creds";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { D1 } from "./d1-remote";
import { LIVE_BUCKET, getObject, listObjects, resolveStore } from "./vault-sync";
import { keyringOwnerOf, openStored, openVaultFor, parseRawKey } from "./raw-cipher-cli";
import { assertTargetConsistent } from "./target";
import { runDir } from "./export-dir";
import { flushOrgKeyUses } from "./access-log";
import { isMain } from "./is-main";
import { MANIFEST, isImageKey, sha256Hex, type StagedEntry } from "./raw-copy-manifest";

export async function main(): Promise<void> {
  assertTargetConsistent();
  const store = resolveStore();
  const allowed = process.env.LEXI_COPY_SOURCE_STORE ?? "dev";
  if (store !== allowed) {
    throw new Error(
      `the export half reads store "${allowed}" and this checkout is bound to "${store}" — ` +
        `set LEXI_COPY_SOURCE_STORE=${store} if that is really the source`,
    );
  }

  const all = (await listObjects(LIVE_BUCKET, `${store}/raw/`)).map((o) => o.key);
  const images = all.filter(isImageKey);
  const bySlug = new Map<string, string[]>();
  for (const key of images) {
    const parsed = parseRawKey(key);
    if (!parsed) continue;
    bySlug.set(parsed.slug, [...(bySlug.get(parsed.slug) ?? []), key]);
  }

  const dir = runDir("rawcopy");
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`source: db=${D1} bucket=${LIVE_BUCKET} store="${store}"`);
  say(`image originals: ${images.length} of ${all.length} raw object(s)\n`);

  const manifest: StagedEntry[] = [];
  let n = 0;
  for (const [slug, keys] of [...bySlug].sort()) {
    const owner = await keyringOwnerOf(store, slug);
    const open = owner ? await openVaultFor(store, owner) : null;
    if (!open) {
      say(`${slug.padEnd(40)} ${String(keys.length).padStart(4)} images  SKIPPED — no vault this lane can open`);
      continue;
    }
    let unsealed = 0;
    let failed = 0;
    let sidecars = 0;
    let bytes = 0;
    for (const r2Key of keys) {
      const stored = await getObject(LIVE_BUCKET, r2Key);
      if (!stored) continue;
      let plain: Uint8Array;
      try {
        plain = await openStored(r2Key, stored, store);
      } catch {
        // A file this lane cannot open is a finding for raw-seal-verify, not a reason to abandon the
        // other eighty: it is counted and the run carries on.
        failed += 1;
        continue;
      }
      const { file } = parseRawKey(r2Key)!;
      const local = `f${String(++n).padStart(4, "0")}.bin`;
      writeFileSync(join(dir, local), plain, { mode: 0o600 });
      const entry: StagedEntry = { slug, file, local, bytes: plain.length, sha256: await sha256Hex(plain) };
      // The extraction sidecar is sealed under the SAME content key as its document
      // (scripts/raw-cipher-cli.ts), so it travels with the file or the re-seal orphans it.
      const sideKey = `${store}/text/${slug}/${file}.json`;
      const side = await getObject(LIVE_BUCKET, sideKey);
      if (side) {
        try {
          const sidePlain = await openStored(sideKey, side, store);
          entry.sidecar = `${local}.text.json`;
          writeFileSync(join(dir, entry.sidecar), sidePlain, { mode: 0o600 });
          sidecars += 1;
        } catch {
          /* a sidecar this lane cannot open is not worth failing its document for */
        }
      }
      manifest.push(entry);
      unsealed += 1;
      bytes += plain.length;
    }
    say(
      `${slug.padEnd(40)} ${String(keys.length).padStart(4)} images  unsealed=${unsealed}  failed=${failed}` +
        `  sidecars=${sidecars}  ${(bytes / 1048576).toFixed(1)} MB`,
    );
  }

  // 0600 and named last: `file` is a patient's own filename, so this is the one file in the
  // directory that discloses who the images belong to.
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const total = manifest.reduce((sum, e) => sum + e.bytes, 0);
  say(`\nstaged ${manifest.length} file(s), ${(total / 1048576).toFixed(1)} MB`);
  say(`staging dir: ${dir}`);
  say(`\nThis is readable patient data. Delete it with: npm run raw:copy-purge`);
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
