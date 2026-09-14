// W15c — the model the treatmentGroups regroup uses, kept separate from scripts/inference-config.ts
// (the full-Finding models). The regroup is a small, bounded leaf and runs on the distinct chat key,
// so it defaults to the cheaper Sonnet tier — a web-triggered regroup can't drain Finding credits.
// This is the explicit configuration: edit here to change it. Isomorphic so both the Pages Function
// and the CLI leaf-regen (W15d) import the same value.
export const REGROUP_MODEL = "claude-sonnet-4-6";
