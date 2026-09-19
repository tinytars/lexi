// W76 — find, date and (after a grace period) delete ORPHANED client namespaces: objects under
// raw/{client}/, text/{client}/ or chat-{client}.enc that no `raw_objects` row attributes. Every route
// refuses them (functions/_lib/raw-owner.ts); the owner reclaims one by opening their vault
// (POST /api/raw/claim) or the operator assigns it (raw-backfill --assign). This removes the rest.
//
//   npm run orphan:sweep                    # report only, writes nothing
//   npm run orphan:sweep -- --record        # also date new orphans, forget resolved ones
//   npm run orphan:sweep -- --delete        # record, then delete orphans older than --grace-days (90)
//
// --delete is irreversible outside the vault-sync backup window — an operator decision, never automatic.

import "./load-creds";
import { d1, q, D1 } from "./d1-remote";
import { listObjects, deleteObject, LIVE_BUCKET, resolveStore, type R2ObjectInfo } from "./vault-sync";
import { clientIdOfObjectKey } from "../functions/_lib/namespace-key";
import { isMain } from "./is-main";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Client namespaces holding objects of which none is attributed, with their objects. */
export function orphanedNamespaces(objects: R2ObjectInfo[], ownedKeys: Iterable<string>): Map<string, R2ObjectInfo[]> {
  const claimed = new Set<string>();
  for (const k of ownedKeys) {
    const c = clientIdOfObjectKey(k);
    if (c) claimed.add(c);
  }
  const out = new Map<string, R2ObjectInfo[]>();
  for (const o of objects) {
    const c = clientIdOfObjectKey(o.key);
    if (!c || claimed.has(c)) continue;
    out.set(c, [...(out.get(c) ?? []), o]);
  }
  return out;
}

/** Orphans first seen at least `graceDays` before `now`. One never recorded is not eligible. */
export function eligibleForDeletion(orphans: Iterable<string>, firstSeen: Map<string, string>, graceDays: number, now: Date): string[] {
  return [...orphans].filter((c) => {
    const seen = firstSeen.get(c);
    return seen !== undefined && now.getTime() - Date.parse(seen) >= graceDays * DAY_MS;
  });
}

function graceDays(argv = process.argv): number {
  const i = argv.indexOf("--grace-days");
  if (i < 0) return 90;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error("--grace-days expects a positive integer");
  return n;
}

async function main(): Promise<void> {
  const del = process.argv.includes("--delete");
  const record = del || process.argv.includes("--record");
  const grace = graceDays();
  const store = resolveStore();
  const now = new Date();

  const objects = [
    ...(await listObjects(LIVE_BUCKET, `${store}/raw/`)),
    ...(await listObjects(LIVE_BUCKET, `${store}/text/`)),
    ...(await listObjects(LIVE_BUCKET, `${store}/chat-`)),
  ];
  const owned = (await d1<{ r2_key: string }>("SELECT r2_key FROM raw_objects")).map((r) => r.r2_key);
  const orphans = orphanedNamespaces(objects, owned);
  const firstSeen = new Map(
    (await d1<{ client_id: string; first_seen: string }>("SELECT client_id, first_seen FROM orphaned_namespaces")).map((r) => [r.client_id, r.first_seen]),
  );

  process.stdout.write(`Target: ${D1} / ${LIVE_BUCKET} (store "${store}")   grace: ${grace} days\n`);
  process.stdout.write(`Objects: ${objects.length}   orphaned namespaces: ${orphans.size}\n\n`);
  for (const [c, objs] of orphans) {
    const bytes = objs.reduce((n, o) => n + o.size, 0);
    process.stdout.write(`  ${c}: ${objs.length} object(s), ${bytes} bytes, first seen ${firstSeen.get(c) ?? "now (unrecorded)"}\n`);
  }

  if (!record) {
    process.stdout.write(`\nReport only. --record dates new orphans; --delete removes those past the grace period.\n`);
    return;
  }

  const fresh = [...orphans.keys()].filter((c) => !firstSeen.has(c));
  if (fresh.length) {
    await d1(`INSERT OR IGNORE INTO orphaned_namespaces (client_id, first_seen) VALUES ${fresh.map((c) => `(${q(c)}, ${q(now.toISOString())})`).join(", ")}`);
    for (const c of fresh) firstSeen.set(c, now.toISOString());
  }
  const resolved = [...firstSeen.keys()].filter((c) => !orphans.has(c));
  if (resolved.length) await d1(`DELETE FROM orphaned_namespaces WHERE client_id IN (${resolved.map(q).join(", ")})`);
  process.stdout.write(`\nRecorded ${fresh.length} new orphan(s); forgot ${resolved.length} resolved.\n`);

  if (!del) return;
  const eligible = eligibleForDeletion(orphans.keys(), firstSeen, grace, now);
  process.stdout.write(`\nDeleting ${eligible.length} namespace(s) orphaned ${grace}+ days:\n`);
  for (const c of eligible) {
    for (const o of orphans.get(c) ?? []) {
      await deleteObject(LIVE_BUCKET, o.key);
      process.stdout.write(`  deleted ${o.key} (${o.size} bytes)\n`);
    }
    await d1(`DELETE FROM orphaned_namespaces WHERE client_id = ${q(c)}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}
