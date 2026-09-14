// Every doctor question, derived ONCE.
//
// Same shape and same reason as analysis-items.ts: three surfaces render the same list and each had
// its own copy of the derivation. Two were verbatim identical and said so in a comment
// (QuestionsForDr.svelte and questions-sidebar-groups.ts); the third, search-index.ts, had drifted
// in a way that showed — it iterated the WHOLE doctorConversation, with no slice and no ordering,
// so search offered questions the page never renders and whose anchors resolve to nothing.
//
// The slice is the load-bearing part, and W76 moved it to doctor-conversation.ts: `doctorConversation`
// holds the per-system question groups FIRST, and then further groups that belong to other sections
// entirely (report-sections.ts). Only the leading ones are this section's, which is why every reader
// has to take the same prefix — and why a reader that forgets produces a search hit that navigates
// nowhere.
import type { Client } from "./types";
import { questionAnchor } from "./anchor";
import { systemOrder } from "@pablotech/akesi-pil/system-groups";
import { dcSlices } from "./doctor-conversation";
import { isPinnedItem } from "@pablotech/akesi-pil/item-registry";
import { sortPinnedFirst } from "./pin-sort";

export interface QuestionItem {
  /** The body system this question was raised under — a bucket, not the item itself. */
  group: string;
  question: string;
  /** The question's ORIGINAL index within its group. The anchor is positional, so this must survive
   *  any reordering (pinned-first included) — the same rule ideaLeaf and questionLeaf follow. */
  index: number;
  anchor: string;
  pinned: boolean;
}

export interface QuestionGroup {
  group: string;
  questions: string[];
}

/**
 * This section's question groups, in System Analysis order.
 *
 * Ordered by `systemOrder` rather than the model's emission order so the body-system sequence
 * matches every other grouped section, and empty groups are dropped.
 */
export function questionGroups(client: Client): QuestionGroup[] {
  const order = systemOrder(client);
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  return dcSlices(client)
    .inference.filter((g) => g?.questions?.length)
    .sort((a, b) => rank(a.group) - rank(b.group));
}

/**
 * Every question as its own item, pinned-first.
 *
 * Flat because that is the granularity the body renders and search matches at — a group is a
 * sidebar bucket, not a leaf (M91 Phase 5's ruling). Pinned-first because the sidebar's All row
 * sorts that way and the body did not, so pinning a question moved its row to the top while its
 * cell stayed put — the same two-surfaces-disagree defect HealthReports had for reports.
 *
 * `sortPinnedFirst` is stable, so filtering this list by group gives exactly the order sorting that
 * group's own items would — which is what lets the per-topic sidebar rows read off the same list.
 */
export function questionItems(client: Client): QuestionItem[] {
  const items = questionGroups(client).flatMap((g) =>
    g.questions.map((q, index) => ({
      group: g.group,
      question: q,
      index,
      anchor: questionAnchor(g.group, index),
      pinned: isPinnedItem(client, "question", q),
    })),
  );
  return sortPinnedFirst(items);
}
