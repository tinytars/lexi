// Extracted from UnifiedTreatment.svelte's saveNewTreatment medicine-scope branch (W79 phase 4b) —
// deciding, then applying, the patch a medicine-scope save fans out across every dose row of the
// drug. Attachments are deliberately NORMALIZED (replaced), not appended: `patch.attachments` is the
// medicine's whole attachment set as the form left it, so removing one there removes it from every
// row rather than surviving on a sibling — this is the existing, intended behavior (not a bug to
// fix), asserted explicitly by the test for this module rather than left implicit.

import type { Administration, Attachment, TreatmentItem } from "./types";
import { administrationUnitChanged } from "@pablotech/akesi/treatment-product";

export interface MedicineFanoutFields {
  name: string;
  reason?: string;
  kind: TreatmentItem["kind"];
  description?: string;
  maker?: string;
  ingredients?: TreatmentItem["ingredients"];
  links?: TreatmentItem["links"];
  administration?: Administration;
  extracted?: TreatmentItem["extracted"];
  rawCaptureAttachmentKeys?: string[];
  rawCaptureText?: string;
  attachments: Attachment[];
}

export interface MedicineFanoutPlan {
  patch: Partial<TreatmentItem>;
  relabelUnit: string | null;
}

export function planMedicineFanout(
  fields: MedicineFanoutFields,
  prevAdministration: Administration | undefined,
): MedicineFanoutPlan {
  const relabelUnit = administrationUnitChanged(prevAdministration, fields.administration)
    ? fields.administration!.unit
    : null;
  const patch: Partial<TreatmentItem> = {
    name: fields.name,
    reason: fields.reason,
    kind: fields.kind,
    attachments: [...fields.attachments],
    images: undefined,
    description: fields.description,
    maker: fields.maker,
    ingredients: fields.ingredients ? [...fields.ingredients] : undefined,
    links: fields.links ? [...fields.links] : undefined,
    administration: fields.administration ? { ...fields.administration } : undefined,
    extracted: fields.extracted ? { ...fields.extracted } : undefined,
    rawCaptureAttachmentKeys: fields.rawCaptureAttachmentKeys ? [...fields.rawCaptureAttachmentKeys] : undefined,
    rawCaptureText: fields.rawCaptureText,
  };
  if (relabelUnit != null) patch.doseUnit = relabelUnit;
  return { patch, relabelUnit };
}

export function applyMedicineFanoutPatch(
  rows: TreatmentItem[] | undefined,
  prevNameLower: string,
  patch: Partial<TreatmentItem>,
): void {
  for (const x of rows ?? []) {
    if (x.name.trim().toLowerCase() !== prevNameLower) continue;
    Object.assign(x, patch);
  }
}
