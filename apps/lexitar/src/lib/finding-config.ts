// W72 — the key the monolithic core call's brain version is stamped under (see brain-source.ts).
// It lives in this leaf module rather than beside brainSourceFor because finding-assemble.ts needs
// it, and brain-source.ts imports finding-generate.ts, which imports finding-assemble.ts — a cycle
// that would leave SYSTEM_PROMPT undefined at module-evaluation time.
export const CORE_BRAIN = "core";
