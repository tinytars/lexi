// W87 — persistence for the regen log, which used to live inside the vault blob.
//
// WHAT WENT WRONG. `Client.regenLog` is append-only evidence: each leaf regeneration appends the
// before and after text of every Finding section it rewrote (src/lib/regen-log.ts). The vault blob
// is re-encrypted and re-uploaded WHOLE on every unrelated edit, so that evidence was paid for on
// every save of every record — and it grows without bound. One record reached 5,163,393 bytes,
// 98.5% of /api/vault/{id}'s 5 MB ceiling, and the next save after that could not be stored at all:
// the patient's record became unsaveable in exchange for carrying evidence nothing reads.
//
// WHY A MOVE AND NOT A CAP. src/lib/regen-log.ts:14-18 wrote the answer down before the ceiling was
// reached, and it is kept verbatim there rather than restated here: a truncation silently deletes
// the long baseline at exactly the point it starts paying off, and it is not recoverable. A move is.
//
// WHY A SEGMENT PER SAVE, AND NOT ONE BLOB LIKE chat-store.ts. A thread is EDITED, which is what
// buys that store its etag, its 412, its re-read-and-merge and its unreadable-blob refusal. A regen
// event is never edited, so each write here is its own immutable object: no precondition, no
// conflict, no merge, and append stays O(1) in the size of the log forever. A single blob would put
// the whole history back on the wire — and into the Worker's isolate memory — on every append,
// which is the cost being removed rather than relocated.
//
// Transport mirrors vaultSink's build-time split: the deployed build PUTs /api/regen-log/{id} and
// the server mints the segment key; dev (vite, e2e) keeps the sealed segments in localStorage.
//
// Sealed with encryptVaultV2 under the vault's own DEK, so a DEK rotation has to re-seal these
// segments by hand — scripts/vault-rekey.ts walks this namespace for exactly that reason, and
// `chat-` is no longer the only one it has to.

import { encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";
import { bytesToB64, b64ToBytes } from "@tinytars/vault/base64";
import { normalizeClientId } from "./client-id";
import { withClient } from "./vault-clients";
import type { Client, RegenEvent, Vault } from "./types";

interface RegenSegment {
  events: RegenEvent[];
}

/** One client's events, as handed to a single segment write. */
export interface RegenBatch {
  clientId: string;
  events: RegenEvent[];
}

export interface RegenRelocation {
  /** The vault to save: every client's `regenLog` removed, except where its write failed. */
  vault: Vault;
  /** The events now durable in R2, in write order. */
  written: RegenEvent[];
  /** Client ids whose segment write failed; their log is still in `vault`. */
  failed: string[];
}

const lsKey = (id: string) => `regen-log:${normalizeClientId(id)}`;

/**
 * The events this session has already written to a segment, by object identity.
 *
 * It is what makes the drain safe against the app's optimistic saves. `src/App.svelte`'s saveEdits
 * and recordRawKey assign the live vault BEFORE their write resolves, so the vault in memory can
 * still carry a log that has just been relocated — and the next save would then write those same
 * events a second time, forever, since each save re-reads the live vault. Filtering here rather
 * than trusting a caller to strip the right object means a regen that landed DURING the window is
 * kept (it is a different object) while a relocated one can never be written twice.
 *
 * A WeakSet because it holds nothing alive: once the vault carrying an event is replaced, the entry
 * goes with it.
 */
const relocated = new WeakSet<RegenEvent>();

const encrypt = (events: RegenEvent[], dek: CryptoKey) => encryptVaultV2<RegenSegment>({ events }, dek);

async function r2Append(id: string, blob: Uint8Array): Promise<void> {
  // Session-gated; a same-origin fetch sends the hd_session cookie automatically. No precondition:
  // the server mints the key, so there is no object to race for.
  const res = await fetch(`/api/regen-log/${encodeURIComponent(normalizeClientId(id))}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob as BodyInit,
  });
  if (!res.ok) throw new Error(`regen log append failed (${res.status})`);
}

function lsAppend(id: string, blob: Uint8Array): void {
  if (typeof localStorage === "undefined") return;
  const held = localStorage.getItem(lsKey(id));
  const segments: string[] = held ? (JSON.parse(held) as string[]) : [];
  segments.push(bytesToB64(blob));
  localStorage.setItem(lsKey(id), JSON.stringify(segments));
}

/** Seal one batch and append it as a new segment. Returns the segment's size in bytes. */
export async function recordRegenEvents(events: RegenEvent[], clientId: string, dek: CryptoKey): Promise<number> {
  const blob = await encrypt(events, dek);
  if (import.meta.env.DEV) lsAppend(clientId, blob);
  else await r2Append(clientId, blob);
  return blob.length;
}

/**
 * Every event ever recorded for one client, oldest first.
 *
 * Nothing in the app calls this yet, and that is the honest state of the log rather than an
 * oversight: it had no reader inside the vault either (src/lib/leaf-regen-client.ts:184 is its only
 * writer). It exists because that is what makes this a migration — the evidence stays reachable, by
 * the holder of the DEK and nobody else — and a relocation with no way back is a deletion.
 */
export async function loadRegenLog(clientId: string, dek: CryptoKey): Promise<RegenEvent[]> {
  const blobs = import.meta.env.DEV ? lsSegments(clientId) : await r2Segments(clientId);
  const events: RegenEvent[] = [];
  for (const blob of blobs) {
    // One unreadable segment does not hide the rest: a pre-rotation blob is a known state here.
    try {
      events.push(...((await decryptVaultV2<RegenSegment>(blob, dek)).events ?? []));
    } catch {
      continue;
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

function lsSegments(id: string): Uint8Array[] {
  if (typeof localStorage === "undefined") return [];
  const held = localStorage.getItem(lsKey(id));
  return held ? (JSON.parse(held) as string[]).map(b64ToBytes) : [];
}

async function r2Segments(id: string): Promise<Uint8Array[]> {
  const slug = encodeURIComponent(normalizeClientId(id));
  const list = await fetch(`/api/regen-log/${slug}`, { cache: "no-store" });
  if (list.status === 404) return [];
  if (!list.ok) throw new Error(`regen log list failed (${list.status})`);
  const { segments } = (await list.json()) as { segments: string[] };
  const out: Uint8Array[] = [];
  for (const segment of segments) {
    const res = await fetch(`/api/regen-log/${slug}?segment=${encodeURIComponent(segment)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`regen log segment fetch failed (${res.status})`);
    out.push(new Uint8Array(await res.arrayBuffer()));
  }
  return out;
}

/**
 * Pure. The vault with every `regenLog` removed, and the events that still have to be written.
 *
 * The field is removed whether or not there is anything to write, because an event already
 * relocated is durable and carrying it a second time is the whole defect. An event this session has
 * not written is returned as a batch, and the caller puts it BACK if its write fails.
 */
export function takeRegenLog(vault: Vault): { vault: Vault; batches: RegenBatch[] } {
  const batches: RegenBatch[] = [];
  let clients: Record<string, Client> | null = null;
  for (const [id, client] of Object.entries(vault.clients)) {
    const log = client.regenLog;
    if (!log || log.length === 0) continue;
    const fresh = log.filter((e) => !relocated.has(e));
    if (fresh.length > 0) batches.push({ clientId: id, events: fresh });
    clients ??= { ...vault.clients };
    const stripped: Client = { ...client };
    delete stripped.regenLog;
    clients[id] = stripped;
  }
  return { vault: clients ? { ...vault, clients } : vault, batches };
}

/**
 * Pure. The LIVE vault with its already-relocated events dropped, keeping any that arrived since.
 *
 * Hygiene rather than correctness — `takeRegenLog` filters the same set, so a save is already safe
 * without this. What it buys is that the in-memory record stops carrying megabytes of events that
 * are durable elsewhere and that every subsequent `{...client}` would copy.
 */
export function dropRelocated(vault: Vault): Vault {
  let clients: Record<string, Client> | null = null;
  for (const [id, client] of Object.entries(vault.clients)) {
    const log = client.regenLog;
    if (!log || log.length === 0) continue;
    const keep = log.filter((e) => !relocated.has(e));
    if (keep.length === log.length) continue;
    clients ??= { ...vault.clients };
    const next: Client = { ...client };
    if (keep.length > 0) next.regenLog = keep;
    else delete next.regenLog;
    clients[id] = next;
  }
  return clients ? { ...vault, clients } : vault;
}

/**
 * Write every pending segment, THEN hand back the vault to save.
 *
 * The order is the safety property: the evidence leaves the record only once it is durable
 * somewhere else, so a failed segment write costs a save that was going to fail anyway rather than
 * the log. `write` is injected so those two outcomes are testable without a network.
 *
 * It does not throw. A segment failure must not block a save that would otherwise succeed — the
 * patient is trying to store their record, and the log is not what they asked to store.
 */
export async function relocateRegenLog(
  vault: Vault,
  dek: CryptoKey,
  write: (events: RegenEvent[], clientId: string, dek: CryptoKey) => Promise<number> = recordRegenEvents,
): Promise<RegenRelocation> {
  const { vault: drained, batches } = takeRegenLog(vault);
  const written: RegenEvent[] = [];
  const failed: string[] = [];
  let out = drained;
  for (const batch of batches) {
    try {
      const bytes = await write(batch.events, batch.clientId, dek);
      for (const e of batch.events) relocated.add(e);
      written.push(...batch.events);
      // The measurement the vault could not give us: no server-side regen telemetry exists, and the
      // blob is never decrypted, so the size of one client's log is first known the moment it is
      // sealed on its own. A count and a byte count — never an event's contents.
      console.info(`regen-log: relocated ${batch.events.length} event(s), ${bytes} bytes, for ${batch.clientId}`);
    } catch (e) {
      failed.push(batch.clientId);
      out = withClient(out, batch.clientId, { ...out.clients[batch.clientId], regenLog: batch.events });
      console.warn(`regen-log: segment write failed for ${batch.clientId}, keeping the log in the record`, e);
    }
  }
  return { vault: out, written, failed };
}
