import type { Client } from "./types";
import { explorationItemAnchor } from "./anchor";

export interface Req { type: string; group?: string; items: string[]; dueSoon: string[] }

const RANK: Record<string, number> = { new: 0, overdue: 1, "due soon": 2 };
const reqRank = (item: string): number => {
  const m = item.match(/^\[([^\]]+)\]/);
  return m ? (RANK[m[1].trim().toLowerCase()] ?? 3) : 3;
};
const isDueSoon = (item: string): boolean => /^\[\s*due soon\s*\]/i.test(item);

// M103 Phase 6 — relocated verbatim from ExplorationCell.svelte's module script so plain-vitest
// search-index.ts can import it without the Svelte plugin. Shared with TestsToConsider.svelte's
// own `allEntries` derivation and SearchPanel's exploration resolver, so all three build the exact
// same due-soon split from one source of truth.
export function buildExplorationRows(client: Client): Req[] {
  return (client.finding?.dataRequisition ?? [])
    .filter((g) => g?.items?.length)
    .map((g) => {
      const sorted = [...g.items].sort((a, b) => reqRank(a) - reqRank(b));
      return {
        type: g.type,
        group: g.group,
        items: sorted.filter((it) => !isDueSoon(it)),
        dueSoon: sorted.filter(isDueSoon),
      };
    });
}

/**
 * ONE exploration item, as its own addressable cell.
 *
 * Exploration was the last section whose items were not units: Study renders one LeafCard per
 * entry (patient turn + LexiTar turn) and Hypothesis one rg-grid row per idea, but Exploration
 * rendered one AI bubble per (system, modality) with its items as bare <li>s — so an item had no
 * card, no actions, and nothing for a per-item record to attach to.
 *
 * An exploration item is the LexiTar half of a turn the patient never took: LexiTar proposes a
 * test unprompted. So the cell is the same tuple shape, with the patient side simply absent.
 *
 * `index` stays the item's position WITHIN its side, because explorationItemAnchor — and
 * search-index.ts's explorationSearchLeaves, which must resolve to the same DOM node — are both
 * built on it.
 */
export interface ExplorationTuple {
  group?: string;
  type: string;
  side: "items" | "dueSoon";
  index: number;
  text: string;
  anchor: string;
}

export function tuplesOf(r: Req): ExplorationTuple[] {
  const of = (side: "items" | "dueSoon") =>
    r[side].map((text, index) => ({
      group: r.group,
      type: r.type,
      side,
      index,
      text,
      anchor: explorationItemAnchor(r.group, r.type, side, index),
    }));
  return [...of("items"), ...of("dueSoon")];
}

/** Every exploration item across every modality, in render order. */
export function explorationTuples(client: Client): ExplorationTuple[] {
  return buildExplorationRows(client).flatMap(tuplesOf);
}
