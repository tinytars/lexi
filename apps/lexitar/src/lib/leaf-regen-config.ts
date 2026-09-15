// W15d/M?? — the two numbers that decide whether a leaf regen can finish, in ONE place.
//
// They used to be inline in leaf-regen-anthropic.ts (a hardcoded 4096/8192) and absent entirely on
// the client, which is how a Translate could sit on "Translating…" forever: nothing bounded it.

// Output ceiling for a leaf regen. 100k needs streaming — the SDK refuses a NON-streaming request
// whose max_tokens implies a >10-minute generation, which is what capped this at 8192 and made
// studyResults/noteResults come back stop_reason="max_tokens" as half-written tool calls. Only
// tokens actually produced are billed, so a high ceiling costs nothing on the small scoped calls.
export const LEAF_REGEN_MAX_TOKENS = 100_000;

// Hard wall-clock limit on one leaf regen as seen from the browser. Past this the client aborts and
// reports a reason, rather than waiting on a socket that a Cloudflare cut may already have killed.
//
// Two minutes, not five: this is what a person experiences as "the time limit", and five minutes of
// an unexplained spinner is indistinguishable from the hang it replaced. Cloudflare gives up on a
// buffered response well before this anyway, so a longer wait only delays a verdict already made.
export const LEAF_REGEN_DEADLINE_MS = 120_000;

// How many attached documents one leaf regen may carry. The per-document and total character caps
// (document-read.ts) are what actually bound the request size; this bounds the number of sidecar
// fetches a single Translate makes before it can start.
export const MAX_LEAF_DOCUMENTS = 6;
