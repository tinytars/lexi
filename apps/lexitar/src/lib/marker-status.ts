// W71 — the two pieces of MarkerChart's accessibility that are pure functions of the data, pulled out
// of the component so they can be tested by BEHAVIOUR.
//
// They were previously inline `$derived`s, and the only way anything checked them was
// tests/unit/a11y-static.test.ts asserting that MarkerChart.svelte's SOURCE contained the string
// "out of range" and `aria-label={chartLabel}`. That is the anti-pattern W68 removed from this
// codebase, relocated to Svelte source text: it detects deletion and nothing else, and a rename or a
// refactor that kept the behaviour perfectly would fail it while a change that broke the sentence for
// a screen-reader user — a wrong unit, a dropped date, the status silently omitted — would pass.
//
// Extracting them is the fix the lesson actually asks for. The component keeps the rendering; the
// judgement about what a blind patient hears lives here, where it can be asserted directly.

/** The three clinical statuses a marker reading can carry, plus "no opinion". */
export type MarkerStatus = "danger" | "warn" | "safe" | "none";

/**
 * The status IN WORDS.
 *
 * W70 — safe/warn/danger used to be carried by border-colour and the value's text colour alone, in
 * the most clinically loaded widget in a patient-facing app: a WCAG 1.4.1 failure, and invisible to
 * the ~6% of males with deuteranopia as well as to every screen reader. The colour stays — redundant
 * colour ON TOP OF text is correct; colour INSTEAD OF text was the defect.
 *
 * Empty string for an unknown status rather than a placeholder: the caller filters it out, and
 * "unknown" read aloud after every marker without a range would be noise, not information.
 */
export function statusWord(status: string): string {
  if (status === "danger") return "out of range";
  if (status === "warn") return "watch";
  if (status === "safe") return "in range";
  return "";
}

export interface ChartLabelInput {
  name: string;
  /** The formatted reading, already scaled for display. Absent when there are no readings. */
  value?: string;
  /** Display unit, already resolved. Omitted for a marker whose value carries its own text. */
  unit?: string;
  status: string;
  date?: string;
}

/**
 * What a screen reader hears instead of just the marker's name.
 *
 * `role="img"` makes the SVG's internals — including the <title> on each data point — inert to
 * assistive tech, so a chart previously conveyed the name and nothing else: no value, no units, no
 * date, no whether the patient is in range. A sentence beats an unusable data grid.
 */
export function chartLabel({ name, value, unit, status, date }: ChartLabelInput): string {
  if (value === undefined) return `${name}: no readings on file`;
  const withUnit = unit ? `${value} ${unit}` : value;
  return [`${name}: ${withUnit}`, statusWord(status), date ? `as of ${date}` : ""].filter(Boolean).join(", ");
}
