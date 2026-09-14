import type { Client, NoteAttachment } from "./types";

export interface NotePair { id: string; text: string; result?: string; group?: string; attachment?: NoteAttachment }

// Shared with Notes.svelte's own read (patient) model and SearchPanel's note resolver, so both
// build the exact same patient-row/AI-result pairing from one source of truth. Mirrors
// study-pairs.ts's buildStudyPairs, but paired by `noteId` rather than a label — a note has no
// short hand-picked focus like Study's to match on verbatim (see finding-assemble.ts's
// noteResults comment).
export function buildNotePairs(client: Client): NotePair[] {
  const notes = client.factors?.noteEntries ?? [];
  const results = client.finding?.noteResults ?? [];
  const byId = new Map(results.map((r) => [r.noteId, r]));
  const rows: NotePair[] = [];
  for (const n of notes) {
    const r = byId.get(n.id);
    rows.push({ id: n.id, text: n.text, result: r?.result, group: r?.group, attachment: n.attachment });
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const r of results) if (!seen.has(r.noteId)) rows.push({ id: r.noteId, text: "", result: r.result, group: r.group });
  return rows;
}
