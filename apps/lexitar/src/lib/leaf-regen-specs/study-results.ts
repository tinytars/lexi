import { STUDY_RESULTS_TOOL, STUDY_RESULTS_SYSTEM_PROMPT } from "../leaf-regen-prompts";
import { assertDiseaseGroups, assertLabelSetMatches, mergeLabeledItems } from "../leaf-regen-rows";
import type { LeafRegenSpec } from "./spec";

type StudyItem = { study: string; result: string; group: string };

// Patches finding.studyResults[].result by `study` label and appends rows for studies with no entry yet.
export const studyResults: LeafRegenSpec = {
  node: "studyResults",
  ownedSections: ["studyResults"],
  toolSchema: STUDY_RESULTS_TOOL,
  systemPromptExtra: STUDY_RESULTS_SYSTEM_PROMPT,
  scopedArrayKey: "items",
  isEmpty: (context) => {
    const study = context.pursuedStudy as { entries?: unknown[] } | undefined;
    return !study || !(study.entries && study.entries.length > 0);
  },
  validate: (raw): { items: StudyItem[] } => {
    const items = (raw as { items?: unknown })?.items;
    if (!Array.isArray(items)) throw new Error("items missing or not an array");
    for (const entry of items) {
      const e = entry as Partial<StudyItem>;
      if (typeof e?.study !== "string" || typeof e?.result !== "string" || typeof e?.group !== "string") {
        throw new Error("item does not match { study, result, group } shape");
      }
      if (e.study.trim() === "" || e.result.trim() === "" || e.group.trim() === "") {
        throw new Error("item has an empty study, result or group");
      }
    }
    return { items: items as StudyItem[] };
  },
  checkAgainstInput: (context, result, targetLabels) => {
    const entries = (context.pursuedStudy as { entries?: { focus: string }[] } | undefined)?.entries ?? [];
    assertLabelSetMatches(
      "studyResults",
      "study rows",
      entries.map((e) => e.focus),
      (result as { items: { study: string }[] }).items.map((i) => i.study),
      targetLabels,
    );
  },
  mergeInto: (client, result) => {
    const { items } = result as { items: StudyItem[] };
    assertDiseaseGroups(client, "studyResults", items);
    const studyResults = mergeLabeledItems(
      client.finding?.studyResults ?? [],
      items,
      (s) => s.study,
      (item, existing) =>
        existing
          ? { ...existing, result: item.result }
          : { study: item.study, result: item.result, group: item.group ?? "" },
    );
    return { ...client, finding: { ...client.finding!, studyResults } };
  },
};
