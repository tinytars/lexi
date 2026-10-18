// M96 Phase 8 — the sidebar's Questions lower zone: an "All" row (every question) plus one row per
// doctorConversation group. W63 — the derivation itself moved to question-items.ts, which the body
// and search read too; this file is now only the row SHAPE, not a second copy of the ordering.

import type { Client } from "./types";
import type { SidebarGroupRow } from "@tinytars/frame/sidebar-rows";
import { ALL_GROUP_KEY, ALL_GROUP_LABEL } from "./sidebar-labels";
import { questionGroups, questionItems, type QuestionItem } from "./question-items";
import { questionLeaf } from "./sidebar-leaf-mappers";

export function questionsSidebarGroups(client: Client): SidebarGroupRow[] {
  // `index` is the question's ORIGINAL position in its group (the anchor is positional); only the
  // ORDER of the mapped leaves is pinned-first, exactly as ideaLeaf's own comment requires.
  const leafOf = (it: QuestionItem) => questionLeaf(it.group, it.index, it.question, it.pinned);
  const all = questionItems(client);
  return [
    { key: ALL_GROUP_KEY, label: ALL_GROUP_LABEL, count: all.length, children: all.map(leafOf) },
    ...questionGroups(client).map((g) => {
      // Filtering the already-pinned-first list keeps this row in the same order the All row shows
      // these questions in — sortPinnedFirst is stable, so no second sort is needed.
      const mine = all.filter((it) => it.group === g.group);
      return { key: "topic:" + g.group, label: g.group, count: mine.length, children: mine.map(leafOf) };
    }),
  ];
}
