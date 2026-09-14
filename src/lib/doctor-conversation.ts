// Where `finding.doctorConversation` is cut into its three sections, once.
//
// The array is a concatenation, not a list: the per-body-system question groups come FIRST — one per
// entry in the Finding's `disease` array — then one group per patient-proposed decision, then
// whatever the AI raised on its own. Nothing in the data marks the boundaries; they are implied by
// the lengths of two OTHER arrays, which is why every reader has to reproduce the same arithmetic.
//
// W76 — it was reproduced in two places (report-sections.ts's presence counts and question-items.ts's
// prefix), each with a comment telling the reader to keep it in sync with `FullReport.svelte` — a
// file W24 deleted. The two happened to agree, by one using `disease.length` and the other
// `systemOrder(client).length`, which is the same number for the same reason and by nothing that
// says so. A drift here is silent by construction: the questions still render, just the wrong ones
// under the wrong heading, or a sub-tab that hides itself because its slice came back empty.

import type { Client } from "./types";

export type DcGroup = { group: string; questions: string[] };

export interface DcSlices {
  /** One group per body system in the System Analysis, in the Finding's severity order. */
  inference: DcGroup[];
  /** One group per hypothesis the patient proposed. */
  patient: DcGroup[];
  /** Everything after those two — the questions the AI raised unprompted. */
  ai: DcGroup[];
}

export function dcSlices(client: Client): DcSlices {
  const dc = client.finding?.doctorConversation ?? [];
  const nDisease = client.finding?.disease?.length ?? 0;
  const nPatient = client.finding?.decisions?.patient?.length ?? 0;
  return {
    inference: dc.slice(0, nDisease),
    patient: dc.slice(nDisease, nDisease + nPatient),
    ai: dc.slice(nDisease + nPatient),
  };
}
