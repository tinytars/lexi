// Regenerates tests/fixtures/canonical-golden.json.
//
// Run ONLY for a deliberate, reviewed hashing change — never to make canonical-golden.test.ts pass.
// The fixture's whole value is that it fails when a change that was supposed to be mechanical was not.
// Last regenerated: W71, for the five inputs added to markerLevels (finding-dag.ts).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CANONICAL_VARIANTS } from "../tests/fixtures/canonical-variants";
import { FINDING_DAG } from "../src/lib/finding-dag";
import { nodeInputCanonical } from "../src/lib/node-input-hash";
import { factorsCanonicalString, findingInputsCanonicalString } from "../src/lib/factors-hash";

const out: Record<string, unknown> = {};
for (const [name, build] of Object.entries(CANONICAL_VARIANTS)) {
  const client = build();
  const nodes: Record<string, string> = {};
  for (const n of FINDING_DAG) nodes[n.key] = nodeInputCanonical(client, n.key);
  out[name] = {
    factorsCanonical: factorsCanonicalString(client),
    findingInputsCanonical: findingInputsCanonicalString(client),
    nodes,
  };
}
const dest = fileURLToPath(new URL("../tests/fixtures/canonical-golden.json", import.meta.url));
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} variants to ${dest}`);
