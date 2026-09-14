// M54/4 — the models the treatment add-flow uses to propose a record from what the user has, kept
// separate from scripts/inference-config.ts and mirroring extract-config.ts. Both run on the chat
// key (ANTHROPIC_API_KEY), never FINDING_ANTHROPIC_API_KEY, so they can't drain the Finding credit
// pool whatever the tier. These are the explicit configuration points: edit here to change them.

// Photos: reading a curved bottle label or a blister pack is genuinely hard vision work, so this
// stays on the same chat-tier vision model web extraction uses.
export const TREATMENT_IMAGE_MODEL = "claude-opus-4-7";

// Pasted text: structured extraction from a product sheet the user already has as text. Sonnet is
// ample for it, and this is the common path — a supplement sheet is far easier to paste than to
// photograph — so paying the vision tier for it would be roughly an order of magnitude of waste.
export const TREATMENT_TEXT_MODEL = "claude-sonnet-4-6";

// A formulated supplement's sheet is long: the reference case (Thyroid Support) carries a
// multi-paragraph description plus thirteen structured ingredients. 256 was sized for {name, kind}
// alone and truncates well before that — and truncation throws rather than silently half-filling,
// so an unraised ceiling fails loudly.
export const TREATMENT_INFER_MAX_TOKENS = 4096;

// The pasted sheet itself. 20k characters is ~40x the reference case, and the cap exists so a
// pathological paste can't turn into an expensive call.
export const MAX_TREATMENT_TEXT_CHARS = 20_000;
