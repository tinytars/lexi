// W16 — persistence for chat threads. Threads hold PHI (the record flows into the conversation),
// so they are encrypted in-browser with the vault's DEK (the HD1 v2 envelope model, W44) and only
// the opaque ciphertext leaves the browser. One blob per client.
//
// Transport mirrors vaultSink's build-time split: the deployed build PUTs/GETs the R2-backed
// /api/chat-history/{id} Function (both hd_session-gated since W71); dev (vite, e2e) keeps the
// encrypted blob in localStorage so a reload restores threads without a dev-server endpoint.

import { mergeThreads, type Thread } from "./chat-threads";
import { encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";
import { bytesToB64, b64ToBytes } from "@tinytars/vault/base64";
import { normalizeClientId } from "./client-id";

interface ChatHistory {
  threads: Thread[];
}

// Client ids are already lowercase (G1 made them the lowercased account id), but a vault predating
// that carries a display-cased key, so normalize anyway: the storage key must never depend on casing.
const lsKey = (id: string) => `chat-history:${normalizeClientId(id)}`;

// W71 — the version of the blob this tab last read, per client id. Sent back as If-Match so a second
// tab's save cannot be silently overwritten by this one, the same protection the vault got in W70.
// Module-level for the same reason vault-sink's is: it belongs to the connection, not to a component
// that unmounts when the user switches tabs.
const etags = new Map<string, string>();

/** The stored blob moved between this tab's read and its write. Typed so the retry path can branch
 * on identity rather than on the text of a message. */
export class ChatHistoryConflict extends Error {
  constructor() {
    super("chat history changed since this tab read it");
    this.name = "ChatHistoryConflict";
  }
}

async function r2Load(id: string): Promise<Uint8Array | null> {
  const res = await fetch(`/api/chat-history/${encodeURIComponent(normalizeClientId(id))}`, { cache: "no-store" });
  if (res.status === 404) {
    etags.delete(normalizeClientId(id));
    return null;
  }
  if (!res.ok) throw new Error(`chat history load failed (${res.status})`);
  const etag = res.headers.get("etag");
  if (etag) etags.set(normalizeClientId(id), etag);
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length ? buf : null;
}
async function r2Save(id: string, blob: Uint8Array, replaceUnreadable = false): Promise<void> {
  // Both verbs are gated by the hd_session cookie — same-origin fetch sends it automatically.
  const known = etags.get(normalizeClientId(id));
  const res = await fetch(`/api/chat-history/${encodeURIComponent(normalizeClientId(id))}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      // The escape hatch sends neither precondition: this tab could not read the blob, so it has no
      // etag for it, and create-only would 412 against the object it is deliberately replacing. The
      // route keeps the old bytes aside before writing, which is what makes the unconditional write
      // safe to send at all.
      ...(replaceUnreadable
        ? { "X-Replace-Unreadable": "1" }
        : // No etag means this tab has never seen a stored blob, so claim create-only rather than
          // sending nothing: if another tab wrote one in between, this save must lose, not clobber.
          known
          ? { "If-Match": known }
          : { "If-None-Match": "*" }),
    },
    body: blob as BodyInit,
  });
  // Another tab saved first. The etag is deliberately KEPT: dropping it used to send the next save
  // down the `If-None-Match: "*"` branch above — create-only, against a blob that exists — so every
  // subsequent save 412'd forever and the conversation silently stopped persisting. saveThreads
  // resolves the conflict by re-reading; it needs a signal, not a cleared slot.
  if (res.status === 412) throw new ChatHistoryConflict();
  if (!res.ok) throw new Error(`chat history save failed (${res.status})`);
  const etag = res.headers.get("etag");
  if (etag) etags.set(normalizeClientId(id), etag);
}

function lsLoad(id: string): Uint8Array | null {
  if (typeof localStorage === "undefined") return null;
  const b64 = localStorage.getItem(lsKey(id));
  return b64 ? b64ToBytes(b64) : null;
}

// W71 — client ids whose stored blob EXISTS but could not be decrypted.
//
// The catch below returned null so the chat tab still opened, which is right. What was wrong is what
// happened next: null means "no history", the tab starts fresh, and the first message the patient
// sends overwrites the blob that could not be read. A wrong DEK is usually transient (an unlock that
// hasn't landed, a rotation mid-flight); the overwrite is not. Refusing to save is the recoverable
// choice, so an unreadable conversation survives long enough to be opened with the right key.
const unreadable = new Set<string>();

export async function loadThreads(id: string, dek: CryptoKey): Promise<Thread[] | null> {
  const blob = import.meta.env.DEV ? lsLoad(id) : await r2Load(id);
  unreadable.delete(normalizeClientId(id));
  if (!blob) return null;
  try {
    const hist = await decryptVaultV2<ChatHistory>(blob, dek);
    return hist.threads ?? null;
  } catch {
    // A pre-cutover v1 blob, or a blob under a different DEK. Start fresh rather than break the chat
    // tab — but remember, so saveThreads does not write over it.
    unreadable.add(normalizeClientId(id));
    return null;
  }
}

function refuseIfUnreadable(id: string): void {
  if (unreadable.has(normalizeClientId(id))) {
    throw new Error("this conversation could not be opened with the current key — not overwriting it");
  }
}

const encrypt = (threads: Thread[], dek: CryptoKey) => encryptVaultV2<ChatHistory>({ threads }, dek);

export async function saveThreads(threads: Thread[], id: string, dek: CryptoKey): Promise<void> {
  refuseIfUnreadable(id);
  if (import.meta.env.DEV) {
    if (typeof localStorage !== "undefined") localStorage.setItem(lsKey(id), bytesToB64(await encrypt(threads, dek)));
    return;
  }
  try {
    await r2Save(id, await encrypt(threads, dek));
  } catch (e) {
    if (!(e instanceof ChatHistoryConflict)) throw e;
    await saveMerged(threads, id, dek);
  }
}

// The one retry a conflict gets. Re-reading does double duty: it refreshes the etag this tab writes
// with AND yields the other tab's threads to merge, so neither side's turns are dropped. A second
// conflict is a live race this tab cannot win by trying again, so it surfaces.
async function saveMerged(threads: Thread[], id: string, dek: CryptoKey): Promise<void> {
  const theirs = await loadThreads(id, dek);
  // loadThreads re-evaluates readability, so a blob that has become undecryptable is caught here —
  // the refusal to overwrite it outranks resolving the conflict.
  refuseIfUnreadable(id);
  await r2Save(id, await encrypt(theirs ? mergeThreads(threads, theirs) : threads, dek));
}

/** Whether this client's stored history exists but could not be opened with the session's key. */
export const isUnreadable = (id: string): boolean => unreadable.has(normalizeClientId(id));

// THE ESCAPE HATCH the guard above needs in order to be a safe bet rather than a trap.
//
// `unreadable` refuses every save for as long as the blob cannot be decrypted, on the reasoning
// that a wrong DEK is usually transient. Where it is not — a DEK rotation that re-encrypted the
// vault and never walked chat-, which is what stranded seven histories on 2026-10-06 and
// 2026-10-07 — the account can never save again, and the UI offers nothing to do about it. That is
// a guard with no exit, so this is the exit: explicitly asked for by the patient, never automatic,
// and it does not destroy the conversation it displaces. The route copies the stored bytes to
// `{store}/orphaned-chat/{id}/` before overwriting, so the ciphertext outlives the click and a key
// recovered later still opens it.
//
// It refuses when the history opened normally, so a mis-wired caller cannot use it as a quiet
// unconditional overwrite of a conversation that was perfectly readable.
export async function replaceUnreadableHistory(threads: Thread[], id: string, dek: CryptoKey): Promise<void> {
  const key = normalizeClientId(id);
  if (!unreadable.has(key)) {
    throw new Error("this conversation opened normally — there is nothing to set aside");
  }
  if (import.meta.env.DEV) {
    if (typeof localStorage !== "undefined") localStorage.setItem(lsKey(id), bytesToB64(await encrypt(threads, dek)));
    unreadable.delete(key);
    return;
  }
  await r2Save(id, await encrypt(threads, dek), true);
  // Cleared only after the write lands, so a failed attempt leaves the refusal in force.
  unreadable.delete(key);
}
