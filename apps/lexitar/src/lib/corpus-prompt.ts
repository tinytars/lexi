// The two fixed strings that frame the report corpus: what the documents are, and the model's
// acknowledgement that closes the prefix. See CORPUS.md §3.
//
// They live here rather than beside the assembler that uses them (functions/_lib/inference/corpus.ts)
// because scripts/corpus-measure.ts must count the same prefix the app sends, and `scripts/` is
// type-checked by tsconfig.node.json, which deliberately excludes `functions/` — an import across
// that line drags the D1 vault adapter into a program that rejects its syntax. Prompt text has no
// dependencies, so this is the half that can be shared.

export const CORPUS_PREAMBLE =
  "The documents above are this person's own source reports, complete and unaltered. Answer from them " +
  "directly — quote their wording, read their tables, and count what they actually contain — rather " +
  "than from any summary, extraction or structured record of them elsewhere in this conversation. " +
  "They are background for whatever is asked next, not a request in themselves.";

export const CORPUS_ACK = "I have read the source documents and will answer from them.";
