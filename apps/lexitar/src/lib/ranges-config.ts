// M59 Phase 2 — the model the web Ranges refresh uses. Kept separate from
// scripts/inference-config.ts (which the Function can't import — Node) but guarded equal to
// MODELS.prod.ranges by a test, so a web refresh produces the SAME Ranges as a prod CLI regen.
// The refresh runs on a DISTINCT Ranges-pool key (RANGES_ANTHROPIC_API_KEY), provider-gated.
export const RANGES_MODEL = "claude-opus-4-7";
