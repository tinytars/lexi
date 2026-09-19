// W46 Phase 7 — which leaf-regen nodes' attachments are allowed to reach the Finding pipeline as
// vision input, and how to collect them from a node's already-built context (leaf-regen-context.ts
// buildLeafContext). Deliberately a closed whitelist, not a generic "scan every context value for
// an attachments[] field" loop: per the owner's decision, Reports and Treatment attachments feed
// Finding generation, but Chat and Notes are scratch surfaces with no medical-input value and must
// NEVER reach it — keeping the extraction ONE explicit function per allowed node (reading only that
// node's own known input key) is what makes that boundary enforced in code, not just convention.
// A future node's attachments (e.g. if Notes ever grew one) simply has no entry here, and
// visionAttachmentsFor returns []; it does not need active rejection because it's never reachable.
import type { Attachment, ClientStudy, DiseaseEntry, TreatmentItem } from "./types";
import { isExtractableDocument } from "./document-extract-client";

function isImage(a: Attachment): boolean {
  return a.mediaType.startsWith("image/");
}

const VISION_INPUT_KEY: Record<string, string> = {
  treatmentAssessment: "treatmentHistory",
  diseaseResults: "diagnosedDisease",
};

export const VISION_ENABLED_NODES = Object.keys(VISION_INPUT_KEY);

// `context` is buildLeafContext(node, client)'s output — reads ONLY the one input key each node is
// whitelisted for above (never pursuedNotes, never anything chat-derived), and caps at maxCount so
// one item's attachments can't blow out the request either.
export function visionAttachmentsFor(
  node: string,
  context: Record<string, unknown>,
  maxCount: number,
): Attachment[] {
  const inputKey = VISION_INPUT_KEY[node];
  if (!inputKey) return [];
  const rows = (context[inputKey] as (TreatmentItem | DiseaseEntry)[] | undefined) ?? [];
  // De-duplicated by key: a medicine's attachments are mirrored across its dose rows (they belong to
  // the drug, not to one dose period), so a flat scan would otherwise send the same photo N times
  // and burn the cap on copies.
  const seen = new Set<string>();
  const attachments = rows
    .flatMap((r) => r.attachments ?? [])
    .filter((a) => isImage(a) && !seen.has(a.key) && (seen.add(a.key), true));
  return attachments.slice(0, maxCount);
}

// ---------------------------------------------------------------------------------------------
// Documents. Same closed-whitelist discipline as vision above, and the same reason for it — but a
// DIFFERENT boundary, deliberately, because a document is not a photo.
//
// The owner's line: the Finding stays clean; a LexiTar turn may read the patient's full turn,
// including any attached documents. A leaf IS "the patient says X, LexiTar answers" — a note, a
// treatment, a study question and its attachments are that turn, so the leaf answering it should
// see them. So every leaf that answers a patient turn appears below, where vision admits only two.
//
// What is absent is the point: the monolith's core synthesis (finding-generate.ts — disease,
// clinicalSynthesis, patterns, progression) is the Finding proper and has NO entry here and no
// call site. That is "the Finding stays clean", enforced by the same one-function-per-node closed
// map rather than by convention, so a future node has to be added deliberately to gain access.
type DocumentRow = { attachments?: Attachment[] };

const DOCUMENT_SOURCES: Record<string, (context: Record<string, unknown>) => DocumentRow[]> = {
  noteResults: (c) => (c.pursuedNotes as DocumentRow[]) ?? [],
  treatmentAssessment: (c) => (c.treatmentHistory as DocumentRow[]) ?? [],
  aiOnPlan: (c) => (c.patientPlan as DocumentRow[]) ?? [],
  // pursuedStudy is a ClientStudy object, not an array — the one input key here that isn't a list.
  studyResults: (c) => (c.pursuedStudy as ClientStudy | undefined)?.entries ?? [],
  allergyResults: (c) => (c.patientAllergies as DocumentRow[]) ?? [],
  familyResults: (c) => (c.patientFamilyHistory as DocumentRow[]) ?? [],
  diseaseResults: (c) => (c.diagnosedDisease as DocumentRow[]) ?? [],
  hypothesisEvaluation: (c) => (c.patientHypothesis as DocumentRow[]) ?? [],
};

export const DOCUMENT_ENABLED_NODES = Object.keys(DOCUMENT_SOURCES);

/**
 * The readable documents attached to a node's own input rows, de-duplicated by key and capped.
 *
 * De-duplication matters for the same reason it does above: a treatment's attachments are mirrored
 * across its dose rows because they belong to the drug, not to one dose period, so a flat scan
 * would send the same PDF's text several times and spend the cap on copies.
 */
export function documentAttachmentsFor(
  node: string,
  context: Record<string, unknown>,
  maxCount: number,
): Attachment[] {
  const source = DOCUMENT_SOURCES[node];
  if (!source) return [];
  const seen = new Set<string>();
  return source(context)
    .flatMap((r) => r.attachments ?? [])
    .filter((a) => isExtractableDocument(a) && !seen.has(a.key) && (seen.add(a.key), true))
    .slice(0, maxCount);
}
