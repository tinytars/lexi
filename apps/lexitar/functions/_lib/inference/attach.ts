// The one door a ROUTE goes through: a feature and whose record it is answering about, in; a model
// and that person's own reports, out. Separate from resolve.ts because the corpus reaches D1, R2 and
// the vault adapters, and the CLI scripts that resolve a model must not drag any of that in.
import { INFERENCE, capsFor, maxCorpusPagesFor, type Feature, type InferenceConfig } from "../../../src/lib/model-config";
import { ModelUnsupportedError } from "../model-errors";
import { emptyCorpus, openReportCorpus, reportsAttached, type Corpus, type CorpusEnv } from "./corpus";
import { modelFor, type ResolvedModel } from "./resolve";
import { textStream } from "../text-stream";
import type { Subject } from "./subject";

// Every feature except these six answers a question about one person's record, and therefore
// answers it in sight of that person's own reports (CORPUS.md).
//
// `extract` and `document` are handed THE document by the browser, at a moment when its bytes may
// not be in R2 yet — attaching the corpus would double-count it and make a new client's first
// import impossible against an empty namespace. `benchmarkWeakest` has no client, no R2 and no
// session. `treatmentImage` and `treatmentText` read a pill bottle's own label, which is not in the
// record at all — the route has no clientId to attach one against. `persona` restates a finished
// answer that already holds every fact, which its own `missingFacts` check proves. Each is a
// decision, which is why it is spelled out in a type rather than left to whichever call site
// remembered.
export const UNATTACHED_FEATURES = ["extract", "document", "benchmarkWeakest", "treatmentImage", "treatmentText", "persona"] as const;
export type UnattachedFeature = (typeof UNATTACHED_FEATURES)[number];
export type AttachedFeature = Exclude<Feature, UnattachedFeature>;

export interface AttachedEnv extends CorpusEnv {
  REPORTS?: string;
}

// `citations: {enabled:true}` and `output_config.format` are mutually exclusive, and these two
// features pin their JSON shape with the latter. Derived from the feature rather than passed in by
// the route: a route that forgot would find out as a 400 in front of a real question.
const FORMATTED_OUTPUT: readonly AttachedFeature[] = ["ranges", "markerGroups"];

/** A model AND the reports it must answer from — the only way a route reaches either. */
export type AttachedModel = ResolvedModel & { corpus: Corpus };

/**
 * WHY A ROUTE GETS A SCOPE AND NEVER A `release`.
 *
 * A corpus occupies isolate memory for as long as the request carrying it runs, not for as long as
 * assembling it takes, so the reservation the budget is made of has to be held across the upstream
 * call (see MAX_IN_FLIGHT_CORPUS_BYTES in corpus.ts). Handing six routes a `release()` to call in a
 * `finally` would be strictly worse than not reserving at all: a route that forgets one wedges the
 * isolate's budget permanently, for every request that lands on it afterwards. So the release lives
 * in the two functions below and is unreachable from a route — the same argument that puts
 * `rawAccessFor` inside the assembler rather than in the routes.
 *
 * `who` is not optional and has no default: a new route cannot get a client for `chat` without
 * naming whose record it is answering about, which is what makes forgetting the corpus, or
 * forgetting to authorise it, a type error rather than a review catch.
 *
 * Throws `ModelUnsupportedError` when the configured provider cannot take PDFs. That is the
 * capability contract working as designed — refuse with 422, never quietly answer from less.
 */
async function openAttachedModel(
  env: AttachedEnv,
  feature: AttachedFeature,
  who: Subject,
  config: InferenceConfig,
): Promise<AttachedModel & { release: () => void }> {
  const resolved = modelFor(env, feature, "prod", config);
  if (!reportsAttached(env)) return { ...resolved, corpus: emptyCorpus(), release: () => {} };
  if (!capsFor(feature, config).pdf) throw new ModelUnsupportedError("PDF documents");
  const { corpus, release } = await openReportCorpus(env, who.accountId, who.clientId, {
    citations: !FORMATTED_OUTPUT.includes(feature),
    maxPages: maxCorpusPagesFor(feature, config),
    rawKeys: who.rawKeys,
  });
  return { ...resolved, corpus, release };
}

/** The door for a route that answers when its own work is done. */
export async function withAttachedModel<T>(
  env: AttachedEnv,
  feature: AttachedFeature,
  who: Subject,
  use: (attached: AttachedModel) => Promise<T>,
  config: InferenceConfig = INFERENCE,
): Promise<T> {
  const { release, ...attached } = await openAttachedModel(env, feature, who, config);
  try {
    return await use(attached);
  } finally {
    release();
  }
}

/**
 * The door for a route that answers 200 and then keeps generating: the corpus outlives the handler,
 * so the reservation is released when the STREAM ends, not when this function returns.
 *
 * Still resolved before the Response exists, which is the point of resolving early in both streaming
 * routes: a refusal can only be an HTTP status carrying its limits until the headers are sent.
 */
export async function streamWithAttachedModel(
  env: AttachedEnv,
  feature: AttachedFeature,
  who: Subject,
  pump: (attached: AttachedModel, write: (text: string) => void) => Promise<void>,
  config: InferenceConfig = INFERENCE,
): Promise<Response> {
  const { release, ...attached } = await openAttachedModel(env, feature, who, config);
  return textStream(async (write) => {
    try {
      await pump(attached, write);
    } finally {
      release();
    }
  });
}

/** The same door for the three features that deliberately carry no corpus. */
export function unattachedModelFor(env: object, feature: UnattachedFeature): ResolvedModel {
  return modelFor(env, feature);
}
