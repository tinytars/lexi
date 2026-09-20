// What the configured model can do, asked in the UI's terms rather than the provider's.
//
// The capability itself is declared per provider in inference.config.json and enforced server-side:
// a request past it throws ModelUnsupportedError and the route answers 422 model_unsupported. That
// is the right refusal, but it arrives after the user has chosen a file. These two predicates let a
// surface say so first — an affordance this deployment cannot honour is better not offered at all.
import { capsFor, INFERENCE, type Feature, type InferenceConfig } from "./model-config";

export type ModelAbility = "photos" | "documents";

/**
 * Documents are an OR and photos are not: a model with native PDF input reads the file, and a vision
 * model reads the same pages rendered as images (functions/api/extract.ts). Only a model that can do
 * neither is out of the document business entirely.
 */
export function supports(feature: Feature, ability: ModelAbility, config: InferenceConfig = INFERENCE): boolean {
  const caps = capsFor(feature, config);
  return ability === "photos" ? caps.vision : caps.pdf || caps.vision;
}

// Names the fix, not just the refusal — on a self-hosted deployment the person reading this is
// often the person who chooses the model.
export const ABILITY_UNAVAILABLE: Record<ModelAbility, string> = {
  photos: "The AI model this deployment is configured with can't see photos — configure a vision-capable model to use this.",
  documents:
    "The AI model this deployment is configured with can't read documents — configure a model that accepts PDFs or images to use this.",
};

/** The sentence to show, or null when the feature works here. */
export function unsupportedNote(feature: Feature, ability: ModelAbility, config: InferenceConfig = INFERENCE): string | null {
  return supports(feature, ability, config) ? null : ABILITY_UNAVAILABLE[ability];
}
