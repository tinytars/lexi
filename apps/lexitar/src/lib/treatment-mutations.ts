import type { Attachment, Client, TreatmentItem } from "./types";
import type { NamedTreatmentGroup } from "@pablotech/akesi/treatment-bucket";
import { matchesTreatmentName } from "./treatment-name-match";
import { appendAttachments, isLastRawCaptureAttachment, isLastRawCaptureHolder } from "./attachment-keys";

// Attachments document the drug, not the dose period, so they come along to the new row.
export function duplicateTreatment(t: TreatmentItem, id: string): TreatmentItem {
  return { ...t, id, pinned: undefined };
}

export function clearExtractedData(t: TreatmentItem): void {
  t.name = "";
  t.description = undefined;
  t.maker = undefined;
  t.ingredients = undefined;
  t.administration = undefined;
  t.kind = undefined;
}

export function togglePin(c: Client, id: string): void {
  const match = c.factors?.treatments?.find((x) => x.id === id);
  if (match) match.pinned = !match.pinned;
}

export function removeTreatmentsById(c: Client, ids: ReadonlySet<string>): void {
  const list = c.factors?.treatments;
  if (list) c.factors!.treatments = list.filter((x) => !ids.has(x.id));
}

// Mirrored onto every row of the medicine so deleting an old titration step can't orphan a photo.
export function mirrorAttachments(rows: TreatmentItem[] | undefined, name: string, added: Attachment[]): void {
  for (const x of rows ?? []) {
    if (matchesTreatmentName(x.name, name)) x.attachments = appendAttachments(x.attachments, added);
  }
}

// Returns the refusal message, or null once removed.
export function removeAttachment(t: TreatmentItem, key: string): string | null {
  if (isLastRawCaptureAttachment(t, key)) {
    return "Can't remove the photo this extraction was read from — re-extract from a new photo first.";
  }
  t.attachments = (t.attachments ?? []).filter((x) => x.key !== key);
  return null;
}

export function deleteTreatmentPrompt(t: TreatmentItem, rows: TreatmentItem[]): string {
  const name = t.name?.trim() || "this treatment";
  return isLastRawCaptureHolder(t, rows)
    ? `Remove ${name}? This is the only entry still holding the photo this extraction was read from — deleting it permanently loses that evidence. This can't be undone.`
    : `Remove ${name}? This can't be undone.`;
}

export function deleteMedicinePrompt(g: NamedTreatmentGroup): string {
  const n = g.rows.length;
  return `Remove ${g.name} and all ${n} dose ${n === 1 ? "entry" : "entries"}? This can't be undone.`;
}
