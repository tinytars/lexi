// A formulated supplement's sheet is long: the reference case (Thyroid Support) carries a
// multi-paragraph description plus thirteen structured ingredients. 256 was sized for {name, kind}
// alone and truncates well before that — and truncation throws rather than silently half-filling,
// so an unraised ceiling fails loudly.
export const TREATMENT_INFER_MAX_TOKENS = 4096;

// The pasted sheet itself. 20k characters is ~40x the reference case, and the cap exists so a
// pathological paste can't turn into an expensive call.
export const MAX_TREATMENT_TEXT_CHARS = 20_000;
