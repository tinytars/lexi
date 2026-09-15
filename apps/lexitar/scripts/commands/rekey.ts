// Move every live R2 object of one client from an old id to a new one.
//
// G1 — /api/vault/rotate and migration 0011 between them move the vault blob's D1 row, but neither
// touches the four OTHER namespaces (`chat-`, `raw/`, `text/`, `processed/`). Each is addressed by
// the client id, so a re-key that stopped at the vault would leave the patient's chat history, their
// original PDFs, the extraction cache and every processed artifact stranded under an id nothing
// resolves any more — present in the bucket, unreachable from the app.
//
// Copy → verify → delete, one object at a time. R2 has no server-side rename, and a move that
// deletes before proving the copy landed is a data-loss bug rather than a slow one.

import { listObjects, getObject, putObject, deleteObject, LIVE_BUCKET, mapPool } from "../vault-sync";

// R2 REST is per-object; serial is minutes for a pilot vault, unbounded parallel gets rate-limited.
const CONCURRENCY = 8;

/**
 * The five key shapes one client owns, as `oldPrefix -> newPrefix` pairs.
 *
 * Derived from the same builders `vault-sync.ts` exports (`r2KeyFor` and friends) rather than
 * re-spelled: the ids are lowercased for exactly the reason those are, and a namespace added there
 * without being added here is the failure this function exists to prevent — so it is one list.
 */
export function namespacePairs(store: string, oldId: string, newId: string): [string, string][] {
  const o = oldId.toLowerCase();
  const n = newId.toLowerCase();
  return [
    [`${store}/data-${o}.enc`, `${store}/data-${n}.enc`],
    [`${store}/chat-${o}.enc`, `${store}/chat-${n}.enc`],
    [`${store}/raw/${o}/`, `${store}/raw/${n}/`],
    [`${store}/text/${o}/`, `${store}/text/${n}/`],
    [`${store}/processed/${o}/`, `${store}/processed/${n}/`],
  ];
}

/** Every live key under `oldPrefix`, paired with where it is going. */
async function planFor(oldPrefix: string, newPrefix: string): Promise<[string, string][]> {
  const objects = await listObjects(LIVE_BUCKET, oldPrefix);
  return objects.map((o) => {
    if (!o.key.startsWith(oldPrefix)) throw new Error(`R2 listed "${o.key}" under prefix "${oldPrefix}"`);
    return [o.key, newPrefix + o.key.slice(oldPrefix.length)] as [string, string];
  });
}

export interface RekeyResult {
  moved: number;
  plan: [string, string][];
}

/**
 * Re-key one client's R2 objects. `dryRun` honours the real preview contract: it enumerates every
 * key that would move and writes nothing at all — no copy, no delete.
 *
 * Refuses if any destination already holds an object. A rekey onto an occupied id is either a typo
 * or a half-finished previous run, and overwriting is not the safe reading of either.
 */
export async function rekeyClient(
  oldId: string,
  newId: string,
  store: string,
  dryRun = false,
): Promise<RekeyResult> {
  if (oldId.toLowerCase() === newId.toLowerCase()) throw new Error(`--rekey-client: old and new id are the same ("${oldId}")`);

  const plan: [string, string][] = [];
  for (const [oldPrefix, newPrefix] of namespacePairs(store, oldId, newId)) {
    plan.push(...(await planFor(oldPrefix, newPrefix)));
  }

  if (plan.length === 0) {
    process.stdout.write(`rekey ${oldId} → ${newId}: no objects under any namespace in store "${store}". Nothing to do.\n`);
    return { moved: 0, plan };
  }

  const occupied = (await mapPool(plan, CONCURRENCY, async ([, to]) => ((await getObject(LIVE_BUCKET, to)) ? to : null)))
    .filter((k): k is string => k !== null);
  if (occupied.length > 0) {
    throw new Error(
      `rekey ${oldId} → ${newId}: ${occupied.length} destination key(s) already exist, refusing to overwrite:\n` +
        occupied.map((k) => `  ${k}`).join("\n"),
    );
  }

  if (dryRun) {
    process.stdout.write(`DRY-RUN rekey ${oldId} → ${newId}: would move ${plan.length} object(s). Nothing written.\n`);
    for (const [from, to] of plan) process.stdout.write(`  ${from}\n    → ${to}\n`);
    return { moved: 0, plan };
  }

  process.stdout.write(`\nRe-keying ${plan.length} object(s): ${oldId} → ${newId} (store "${store}")…\n`);
  await mapPool(plan, CONCURRENCY, async ([from, to]) => {
    const body = await getObject(LIVE_BUCKET, from);
    if (!body) throw new Error(`rekey: "${from}" vanished between listing and copy — re-run`);
    await putObject(LIVE_BUCKET, to, body);
    const landed = await getObject(LIVE_BUCKET, to);
    if (!landed || landed.byteLength !== body.byteLength) {
      throw new Error(`rekey: copy of "${from}" → "${to}" did not land intact — old key left in place`);
    }
    await deleteObject(LIVE_BUCKET, from);
    process.stdout.write(`  moved ${from}\n`);
  });

  process.stdout.write(`Re-key complete — ${plan.length} object(s) now under "${newId}".\n`);
  return { moved: plan.length, plan };
}
