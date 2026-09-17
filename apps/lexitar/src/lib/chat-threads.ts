// Chat thread model. Threads are persisted per client as an in-browser-encrypted HD1 blob
// (W16, chat-store.ts) — the same key-loss-proof model as the vault, so PHI is never plaintext
// at rest. adoptThreads() rebases the id/seq counter onto a restored set so new threads never
// collide with hydrated ones.

import type { Permalink } from "./permalink";
import type { ReferenceKind, ResolvedReference } from "./reference-resolver";
import type { Attachment } from "./types";
import { sortPinnedFirst } from "./pin-sort";

export interface ReferenceTurnData {
  permalink: Permalink;
  kind: ReferenceKind;
  preview: { title: string; subtitle?: string; tag: string };
}

export type Turn = {
  role: "user" | "assistant";
  text: string;
  reference?: ReferenceTurnData;
  // W46 Phase 6 — images attached from the chat composer, ridden as real vision content blocks to
  // the model (unlike `reference`, which is metadata-only). Scratch-surface only: never folds into
  // a SourceRecord/pendingUpload, and never reaches the Finding pipeline (see leaf-actions.ts /
  // decision #4 in docs/health-dash/plans/46-w46-attachments-and-previews.md).
  attachments?: Attachment[];
};

export type Thread = {
  id: string;
  title: string;
  pinned: boolean;
  turns: Turn[];
  // Monotonic creation counter (not a wall-clock time — Date.now() is avoided so the
  // model is deterministic/testable); higher = more recent.
  seq: number;
  // Wall-clock time of the last turn appended (or creation); drives sortThreads' recency order.
  lastActivityAt: number;
};

const UNTITLED = "New chat";

let counter = 0;
export function newThread(): Thread {
  counter += 1;
  return { id: `t${counter}`, title: UNTITLED, pinned: false, turns: [], seq: counter, lastActivityAt: Date.now() };
}

// First user message becomes the title (trimmed to a scannable length). Only set
// while still untitled so a manual rename sticks.
export function titleFor(thread: Thread, firstMessage: string): string {
  if (thread.title !== UNTITLED) return thread.title;
  const t = firstMessage.trim().replace(/\s+/g, " ");
  if (!t) return UNTITLED;
  return t.length > 48 ? t.slice(0, 47).trimEnd() + "…" : t;
}

// Shared reference-turn-building logic (M70) — used by both an existing-thread paste
// (ChatTab's onPaste) and a new-thread seed (Phase 2), so the fallback text/shape stays identical.
export function buildReferenceTurn(resolved: ResolvedReference): Turn {
  const text =
    resolved.kind === "wrong-patient" ? "This link is for a different patient — switch patients first"
    : resolved.kind === "unresolved" ? "This link's target could not be found"
    : `Referenced: ${resolved.preview.title} (${resolved.preview.tag})`;
  return {
    role: "user",
    text,
    reference: { permalink: resolved.permalink, kind: resolved.kind, preview: resolved.preview },
  };
}

export function seedNewThread(resolved: ResolvedReference): Thread {
  const thread = newThread();
  const previewText = `${resolved.preview.title}${resolved.preview.subtitle ? " — " + resolved.preview.subtitle : ""}`;
  thread.title = titleFor(thread, previewText);
  thread.turns = [buildReferenceTurn(resolved)];
  return thread;
}

// Rebase the module counter onto a restored set so newThread() ids/seqs stay above every
// hydrated thread. Returns the set to adopt (a fresh thread if the restored set is empty).
//
// Deduplicates by id, keeping the last occurrence: decrypted storage is external input, not a
// value this module produced itself, and a real account has hit a blob carrying the same id
// twice (root cause unconfirmed — plausibly an old concurrent-save race, now guarded at the
// store layer by chat-store.ts's etag check, but that guard is no defense against data already
// written before it existed). Every render keys threads by id ({#each ... (t.id)} in Sidebar,
// row.turnIdx within one thread), so a silent duplicate is not cosmetic — it's an uncaught
// each_key_duplicate crash on every future load of that account's chat tab.
export function adoptThreads(threads: Thread[]): Thread[] {
  const deduped = [...new Map(threads.map((t) => [t.id, t])).values()];
  for (const t of deduped) counter = Math.max(counter, t.seq);
  return deduped.length > 0 ? deduped : [newThread()];
}

// Pinned first, then most-recent-first (by lastActivityAt) within each group. Stable, pure.
export function sortThreads(threads: Thread[]): Thread[] {
  // Threads persisted before lastActivityAt existed round-trip through plain JSON with no schema
  // migration, so a real historical blob can lack the field at runtime; fall back to seq (the
  // prior tiebreak) so ordering stays deterministic instead of comparing undefined - undefined (NaN).
  return sortPinnedFirst(threads).sort((a, b) =>
    a.pinned === b.pinned ? (b.lastActivityAt ?? b.seq) - (a.lastActivityAt ?? a.seq) : 0,
  );
}
