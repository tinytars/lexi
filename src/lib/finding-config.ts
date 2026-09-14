// W15/3b.2 — the model the web Finding refresh uses. Kept separate from
// scripts/inference-config.ts (which the Function can't import — Node) but guarded equal to
// MODELS.prod.finding by a test, so a web refresh produces the SAME Finding as a prod CLI regen.
// The refresh runs on a DISTINCT Finding-pool key (FINDING_ANTHROPIC_API_KEY), provider-gated.
export const FINDING_MODEL = "claude-opus-4-7";

// W72 — the key the monolithic core call's brain version is stamped under (see brain-source.ts).
// It lives in this leaf module rather than beside brainSourceFor because finding-assemble.ts needs
// it, and brain-source.ts imports finding-generate.ts, which imports finding-assemble.ts — a cycle
// that would leave SYSTEM_PROMPT undefined at module-evaluation time.
export const CORE_BRAIN = "core";
