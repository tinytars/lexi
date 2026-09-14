// W15/1 — the model /api/extract uses to read an uploaded clinical report, kept
// separate from scripts/inference-config.ts and mirroring regroup-config.ts. Web
// extraction runs on ANTHROPIC_API_KEY, never FINDING_ANTHROPIC_API_KEY, so it can't
// drain the Finding credit pool whatever the tier. It feeds the Health Reports right column
// (diagnoses), so it defaults to the SAME tier the CLI uses for prod report import
// (claude-opus-4-7) — web-uploaded and CLI-imported reports extract identically.
// This is the explicit configuration point: edit here to change it.
export const EXTRACT_MODEL = "claude-opus-4-7";
