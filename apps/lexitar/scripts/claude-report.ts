// W15/0b — the Node/CLI edge of report extraction. The schema, prompt, PDF/text
// call, and validation now live in src/lib/report-extract.ts (pure, injected
// client) so the Pages Function reuses them; this file keeps the env-keyed
// Anthropic singleton and the CLI call signature unchanged.
import Anthropic from "@anthropic-ai/sdk";
import type { Client, InferenceMode } from "../src/lib/types";
import { MODELS } from "./inference-config";
import type { UsageAccumulator } from "./inference-cost";
import { proposeFromReport as proposeFromReportCore } from "@pablotech/akesi/report-extract";

export {
  REPORT_SCHEMA,
  systemPromptFor,
  validate,
  type ProposedReport,
  type ProposedDiseaseEntry,
  type ProposedComorbidity,
  type ProposedMarkerEntry,
  type ProposedPriorComparison,
} from "@pablotech/akesi/report-extract";

import type { ProposedReport } from "@pablotech/akesi/report-extract";

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (cachedClient) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Required to import medical reports.");
  }
  cachedClient = new Anthropic();
  return cachedClient;
}

// `mode` is retained for call-site compatibility (it never affected extraction —
// the model id is the only lever); the CLI passes MODELS[mode].report as `model`.
export async function proposeFromReport(
  reportText: string,
  sourceFile: string,
  client: Client,
  today: string,
  model: string = MODELS.prod.report,
  mode: InferenceMode = "prod",
  usage?: UsageAccumulator,
): Promise<ProposedReport> {
  void mode;
  return proposeFromReportCore(anthropic(), { text: reportText }, sourceFile, client, today, model, usage);
}
