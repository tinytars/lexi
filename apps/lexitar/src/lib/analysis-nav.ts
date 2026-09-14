// M80 — single source of truth for Analysis's fixed sidebar nav rows and matching in-page anchors,
// so Analysis.svelte's headings and Sidebar.svelte's leaf-list rows can't drift apart. Unlike
// Markers/Hypothesis/Exploration's per-client body-system groups, these 6 blocks are always present.
// W61/W62 — they are no longer "always all rendered": selecting a row FILTERS to that block, and
// selecting one of its child rows filters to that single turn, like every other section.

export interface AnalysisNavRow {
  key: string;
  label: string;
  anchor: string;
  /** The block's wrapper class. Not derivable from key/label/anchor ("progression" heads a block
   *  classed `health-progression`), and e2e selects on it (cover-render.spec.ts), so it is data. */
  cls: string;
  /** The noun in "No {noun} on file for {name}." — the one genuinely per-section string, and also
   *  not derivable: the block labelled "On Treatment" says "no plan assessment". */
  emptyNoun: string;
}

export const ANALYSIS_NAV: AnalysisNavRow[] = [
  { key: "progression", label: "Health Progression", anchor: "analysis-progression", cls: "health-progression", emptyNoun: "progression read" },
  { key: "ontreatment", label: "On Treatment", anchor: "analysis-ontreatment", cls: "on-treatment", emptyNoun: "plan assessment" },
  { key: "system", label: "System Analysis", anchor: "analysis-system", cls: "system-analysis", emptyNoun: "system analysis" },
  { key: "pattern", label: "Pattern & Anti-pattern", anchor: "analysis-pattern-antipattern", cls: "pattern-antipattern", emptyNoun: "pattern analysis" },
  { key: "synthesis", label: "Health Synthesis", anchor: "analysis-clinical-synthesis", cls: "clinical-synthesis", emptyNoun: "health synthesis" },
  { key: "final", label: "Final Thoughts", anchor: "analysis-final-thoughts", cls: "final-thoughts", emptyNoun: "final thoughts" },
];
