// W16 — persistence for chat threads. Threads hold PHI (the record flows into the conversation),
// so they are encrypted in-browser with the vault's DEK (the HD1 v2 envelope model, W44) and only
// the opaque ciphertext leaves the browser. One blob per client.
//
// Transport mirrors vaultSink's build-time split: the deployed build PUTs/GETs the R2-backed
// /api/chat-history/{id} Function (both hd_session-gated since W71); dev (vite, e2e) keeps the
// encrypted blob in localStorage so a reload restores threads without a dev-server endpoint.

import type { Thread } from "./chat-threads";
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
async function r2Save(id: string, blob: Uint8Array): Promise<void> {
  // Both verbs are gated by the hd_session cookie — same-origin fetch sends it automatically.
  const known = etags.get(normalizeClientId(id));
  const res = await fetch(`/api/chat-history/${encodeURIComponent(normalizeClientId(id))}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      // No etag means this tab has never seen a stored blob, so claim create-only rather than
      // sending nothing: if another tab wrote one in between, this save must lose, not clobber.
      ...(known ? { "If-Match": known } : { "If-None-Match": "*" }),
    },
    body: blob as BodyInit,
  });
  if (res.status === 412) {
    // Another tab saved first. Drop our token so the next load re-reads theirs rather than retrying
    // against a version that no longer exists — chat is append-mostly, so re-reading is the merge.
    etags.delete(normalizeClientId(id));
    throw new Error("chat history changed in another tab — reload the conversation");
  }
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

export async function saveThreads(threads: Thread[], id: string, dek: CryptoKey): Promise<void> {
  if (unreadable.has(normalizeClientId(id))) {
    throw new Error("this conversation could not be opened with the current key — not overwriting it");
  }
  const blob = await encryptVaultV2<ChatHistory>({ threads }, dek);
  if (import.meta.env.DEV) {
    if (typeof localStorage !== "undefined") localStorage.setItem(lsKey(id), bytesToB64(blob));
  } else {
    await r2Save(id, blob);
  }
}
