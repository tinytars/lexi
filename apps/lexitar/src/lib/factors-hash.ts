import type { Attachment, Client } from "./types";
import { treatmentsOf } from "@pablotech/akesi-pil/treatment-normalize";
import { productCanonical } from "@pablotech/akesi-pil/treatment-product";
import { pinnedQueryLines } from "@pablotech/akesi-pil/pinned-queries";
import { stableStringify } from "@pablotech/neuro-pil";

/**
 * W75 — the attachments on a row, as a canonical suffix.
 *
 * Attachments steer 8 of the 9 leaf prompts (finding-vision.ts feeds images and extracted document
 * text into the request) and appeared in NO input slice, so attaching or deleting a PDF produced no
 * stale chip and no regen: the answer stayed exactly as it was, computed without the document the
 * patient had just added. This is the largest surviving instance of the class W71 item 9 fixed.
 *
 * The digest is the content-addressed key plus the extracted-text size, because extraction is what
 * changes the prompt — a PDF attached and then read is a different input from the same PDF unread.
 *
 * Returns "" (not "[]", not "|att:") when there is nothing attached, and that is load-bearing for
 * the same reason productCanonical's empty-string return is: every client with no attachments hashes
 * BYTE-IDENTICALLY to before this existed, so adding it does not mark the whole user base stale and
 * fire a full regeneration at once.
 */
export function attachmentsCanonical(attachments?: Attachment[]): string {
  if (!attachments?.length) return "";
  const parts = attachments.map((a) => `${a.key}${a.extracted ? `:${a.extracted.chars}` : ""}`).sort();
  return `|att:${parts.join(",")}`;
}

// W31 — canonical slice of the unified treatments list. Time-independent (no bucketing) so the
// hash only changes on an edit, never as a planned treatment's start date passes. Both the
// treatmentHistory and patientPlan input slices use it, so editing any treatment conservatively
// invalidates every treatment-downstream node (assessment, groups, plan) — never under-invalidates.
// Exported so node-input-hash.ts's INPUT_SLICES can reuse it without duplicating the shape.
export function treatmentCanonical(c: Client): string[] {
  return treatmentsOf(c)
    .map(
      (t) =>
        // M104 — doseAmount/doseUnit/doseFrequency included alongside legacy `dose`: an edit that
        // only touches the structured fields (leaving `dose` untouched/empty) must still change this
        // signature, or the staleness system never notices the AI assessment needs a regen.
        // productCanonical returns "" unless the treatment actually has product data, so every
        // treatment on file today hashes byte-identically to before — otherwise adding these fields
        // would mark every treatment stale and fire a full regeneration for every user at once.
        `${t.name}|${t.dose ?? ""}|${t.doseAmount ?? ""}|${t.doseUnit ?? ""}|${t.doseFrequency ?? ""}|${t.kind ?? ""}|${t.start}|${t.end ?? ""}|${t.reason ?? ""}|${t.timingPeriod ?? ""}${productCanonical(t)}${attachmentsCanonical(t.attachments)}`,
    )
    .sort();
}

// Pure canonicalization of the user-authored inputs that gate ranges (factors)
// and the Finding (factors + study + watchlist + treatments + readings). Shared
// by the Node CLI (scripts/factors.ts hashes these with node:crypto) and the
// browser staleness check (src/lib/staleness.ts hashes them with SubtleCrypto),
// so both sides see the identical canonical string and the same hash.

export function canonicalFactors(client: Client) {
  const f = client.factors ?? {};
  return {
    dob: client.dob,
    gender: client.gender,
    factors: {
      diseases: f.diseases
        ? [...f.diseases]
            .map((d) => ({ date: d.date, diagnostic: d.diagnostic }))
            .sort((a, b) =>
              a.date === b.date ? a.diagnostic.localeCompare(b.diagnostic) : a.date.localeCompare(b.date),
            )
        : undefined,
      pregnancy: f.pregnancy,
      athletic: f.athletic,
      bmi: f.bmi,
      height: f.height,
      smoking: f.smoking,
      ethnicity: f.ethnicity,
      goal: f.goal,
      focus: f.focus,
    },
  };
}

// M71 P6 — projected to focus|detail only (excluding id/pinned) so a Pin toggle never spuriously
// invalidates the pursuedStudy/studyResults DAG nodes. Exported so node-input-hash.ts's
// pursuedStudy slice can reuse it without duplicating the shape (mirrors treatmentCanonical above).
export function studyCanonical(c: Client) {
  return c.study
    ? {
        entries: c.study.entries?.map((e) => {
          const att = attachmentsCanonical(e.attachments);
          return { focus: e.focus, detail: e.detail, ...(att ? { attachments: att } : {}) };
        }),
      }
    : {};
}

// M92 — projected to `text` only (mirrors studyCanonical: pinned status doesn't feed the LLM), NOT
// sorted (unlike most canonical slices below) because noteResults pairs back to notes by ARRAY
// POSITION, so a reorder must invalidate exactly like an edit would. New field — included only when
// non-empty so an existing client with no notes keeps their hash unchanged (same reasoning as
// allergySummaries/familyHistorySummaries below). Exported so node-input-hash.ts's pursuedNotes slice
// can reuse it without duplicating the shape (mirrors studyCanonical's own export).
export function noteCanonical(c: Client): string[] | undefined {
  const notes = (c.factors?.noteEntries ?? [])
    .filter((n) => n.text.trim().length > 0)
    .map((n) => `${n.text}${attachmentsCanonical(n.attachments)}`);
  return notes.length ? notes : undefined;
}

// W61 — moved to @pablotech/neuro-pil (neuro-pil/canonical.ts) so the Node CLI, the browser, and any
// future vault's staleness tooling share one implementation. Re-exported here (imported above) so
// this file's ~6 existing importers don't need to change. See
// docs/health-dash/plans/61-w61-graph-brain-extraction.md.
export { stableStringify };

export function factorsCanonicalString(client: Client): string {
  return stableStringify(canonicalFactors(client));
}

export function findingInputsCanonicalString(client: Client): string {
  const f = client.factors ?? {};
  const results = [...client.results]
    .map((r) => `${r.marker}|${r.date}|${r.value}|${r.unit}`)
    .sort();
  const watchlist = [...client.watchlist].sort();
  const treatments = treatmentCanonical(client);
  const decisions = (f.decisions ?? []).map((d) => `${d.intervention}|${d.purpose}`).sort();
  // Disease summaries feed the Finding but not ranges, so they are hashed here
  // (finding inputs) rather than in canonicalFactors (which also gates ranges).
  const diseaseSummaries = (f.diseases ?? []).map((d) => `${d.date}|${d.diagnostic}|${d.summary ?? ""}`).sort();
  // Allergies/family history feed the Finding narrative only, same reasoning as diseaseSummaries.
  // Unlike diseaseSummaries (a long-established key), these are brand-new — omit outright (rather
  // than `[]`) when empty so every existing client's hash is unchanged until they add real data.
  const allergySummaries = f.allergies?.length ? f.allergies.map((a) => `${a.allergen}|${a.reaction}|${a.severity ?? ""}|${a.dateNoted ?? ""}`).sort() : undefined;
  const familyHistorySummaries = f.familyHistory?.length ? f.familyHistory.map((h) => `${h.relation}|${h.condition}`).sort() : undefined;
  // W62 — the starred areas of query now steer the prompt, so they must invalidate it. OMITTED
  // ENTIRELY when nothing is pinned, not `[]`: every client who has never starred anything hashes
  // byte-identically to before this key existed, so adding it does not mark the whole user base
  // stale and fire a full regeneration at once. Same guard, and the same reason, as
  // allergySummaries/familyHistorySummaries above and productCanonical's empty-string return.
  // client.watchlist is deliberately NOT folded in here — it is already its own key below.
  const pinnedLines = pinnedQueryLines(client);
  const pinnedQueries = pinnedLines.length ? pinnedLines : undefined;
  const payload = {
    factors: canonicalFactors(client),
    pinnedQueries,
    diseaseSummaries,
    allergySummaries,
    familyHistorySummaries,
    study: studyCanonical(client),
    notes: noteCanonical(client),
    watchlist,
    treatments,
    decisions,
    results,
  };
  return stableStringify(payload);
}
