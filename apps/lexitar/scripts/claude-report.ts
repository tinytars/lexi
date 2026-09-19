// W15/0b — the Node/CLI edge of report extraction. The schema, prompt, PDF/text
// call, and validation now live in src/lib/report-extract.ts (pure, injected
// client) so the Pages Function reuses them; this file keeps the
// model client from the inference config and the CLI call signature unchanged.
import type { Client, InferenceMode } from "../src/lib/types";
import { modelId } from "../src/lib/model-config";
import { modelFor } from "../functions/_lib/inference/resolve";
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

const anthropic = () => modelFor(process.env, "extract").client;

// `mode` is retained for call-site compatibility (it never affected extraction —
// the model id is the only lever); the CLI passes modelId("extract", mode) as `model`.
export async function proposeFromReport(
  reportText: string,
  sourceFile: string,
  client: Client,
  today: string,
  model: string = modelId("extract"),
  mode: InferenceMode = "prod",
  usage?: UsageAccumulator,
): Promise<ProposedReport> {
  void mode;
  return proposeFromReportCore(anthropic(), { text: reportText }, sourceFile, client, today, model, usage);
}
