// W15/3b.2 — the thin Node/CLI edge of Finding generation. The prompt, message assembler, the
// streaming call+retry, and the response→ClientFinding assembly moved to src/lib/finding-generate.ts
// + src/lib/finding-assemble.ts (Node-free, so the streaming refresh Function reuses them). This
// file keeps the model client from the inference config, stamps the CLI's node:crypto hashes into the
// assembly, and re-exports the unchanged public API (buildUserMessage / SYSTEM_PROMPT / the
// validators / FindingAIResponse) so ingest, first-look-synthesis, and the tests are untouched.
import type { Client, ClientFinding, InferenceMode } from "../src/lib/types";
import { generateFindingResponse, populatedNoteEntries } from "@pablotech/akesi/finding-generate";
import { assembleFinding } from "@pablotech/akesi/finding-assemble";
import { CORE_BRAIN } from "../src/lib/finding-config";
import { BRAIN_VERSIONS } from "../src/lib/brain-versions";
import { findingInputsHashOf, nodeHashesOf } from "./factors";
import { modelId } from "../src/lib/model-config";
import { modelFor } from "../functions/_lib/inference/resolve";
import type { UsageAccumulator } from "./inference-cost";

export { buildUserMessage, SYSTEM_PROMPT } from "@pablotech/akesi/finding-generate";
export { validateFindingResponse, validateFindingWithInputs, type FindingAIResponse } from "@pablotech/akesi/finding-assemble";

const anthropic = () => modelFor(process.env, "finding").client;

export async function generateFinding(
  client: Client,
  model: string = modelId("finding"),
  mode: InferenceMode = "prod",
  usage?: UsageAccumulator,
  onAttemptFailed?: (attempt: number, reason: string) => void,
): Promise<ClientFinding> {
  const parsed = await generateFindingResponse(anthropic(), client, model, usage, (attempt, reason) => {
    // Local stderr only — the CLI runs on the same machine as the plaintext vault, so naming the
    // rejected section here reveals nothing that machine does not already hold.
    process.stderr.write(`\n  attempt ${attempt} rejected: ${reason}\n  retrying with a correction… `);
    onAttemptFailed?.(attempt, reason);
  });
  return assembleFinding(parsed, {
    generatedAt: new Date().toISOString(),
    inputsHash: findingInputsHashOf(client),
    nodeHashes: nodeHashesOf(client),
    generatedBy: { mode, model },
    noteIds: populatedNoteEntries(client).map((n) => n.id),
    promptVersions: { [CORE_BRAIN]: BRAIN_VERSIONS[CORE_BRAIN] },
  });
}
