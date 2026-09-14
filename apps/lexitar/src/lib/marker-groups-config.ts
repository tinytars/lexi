// W64 — the model the web marker-grouping refresh uses, in the shape every other tier already had
// (finding-config, ranges-config, extract-config, regroup-config, leaf-regen-config,
// treatment-infer-config). refresh-marker-groups.ts hardcoded this id inline under a comment
// claiming it "matches the CLI's prod default" — true only by coincidence, since the CLI's
// generateMarkerGroups defaults to MODELS.prod.ranges rather than .finding, and the only test
// compared the literal to itself. A parity test now pins it, as ranges-config's does.
export const MARKER_GROUPS_MODEL = "claude-opus-4-7";
