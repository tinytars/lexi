// Reads and validates inference.config.json, the one place every model call is configured. Browser-
// safe (no SDK, no env): the browser stamps generatedBy and shows the billing link from here, while
// functions/_lib/inference/resolve.ts turns an entry into a live client.
import raw from "../../inference.config.json";
import type { InferenceMode } from "./types";

export const FEATURES = [
  "chat",
  "persona",
  "extract",
  "document",
  "treatmentImage",
  "treatmentText",
  "finding",
  "ranges",
  "markerGroups",
  "leafRegen",
  "benchmarkWeakest",
] as const;
export type Feature = (typeof FEATURES)[number];

export interface Caps {
  vision: boolean;
  pdf: boolean;
  jsonSchema: boolean;
  tools: boolean;
}
const CAPS: (keyof Caps)[] = ["vision", "pdf", "jsonSchema", "tools"];

export interface AnthropicProvider {
  api: "anthropic";
  keyEnv: string[];
  billingUrl?: string;
  maxCorpusPages?: number;
}

export interface OpenAIProvider {
  api: "openai";
  baseUrl: string;
  /** Empty for a local server that takes no key. */
  keyEnv: string[];
  caps: Caps;
  billingUrl?: string;
  /** OpenAI's current models want max_completion_tokens; older OpenAI-compatible servers want max_tokens. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Clamp on output tokens, for a local model whose context is smaller than the app asks for. */
  maxOutputTokens?: number;
  maxCorpusPages?: number;
}

export type Provider = AnthropicProvider | OpenAIProvider;

export interface InferenceConfig {
  providers: Record<string, Provider>;
  features: Record<Feature, { provider: string; model: string }>;
  dev: Partial<Record<Feature, string>>;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function fail(msg: string): never {
  throw new Error(`inference.config.json: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    if (/key|secret|token/i.test(k)) {
      fail(`${where}.${k}: keys never go in this file — put the key in an env var and name it in keyEnv`);
    }
    fail(`${where}.${k}: unknown field`);
  }
}

function parseProvider(name: string, p: unknown): Provider {
  const where = `providers.${name}`;
  if (!isRecord(p)) fail(`${where} must be an object`);
  const keyEnv = p.keyEnv;
  if (!Array.isArray(keyEnv) || !keyEnv.every((k) => typeof k === "string" && ENV_NAME.test(k))) {
    fail(`${where}.keyEnv must be a list of env var NAMES (e.g. ["ANTHROPIC_API_KEY"]), never a key`);
  }
  if (p.billingUrl !== undefined && (typeof p.billingUrl !== "string" || !p.billingUrl.startsWith("https://"))) {
    fail(`${where}.billingUrl must be an https URL`);
  }
  if (p.maxCorpusPages !== undefined && !(Number.isInteger(p.maxCorpusPages) && (p.maxCorpusPages as number) > 0)) {
    fail(`${where}.maxCorpusPages must be a positive integer`);
  }
  if (p.api === "anthropic") {
    onlyKeys(p, ["api", "keyEnv", "billingUrl", "maxCorpusPages"], where);
    if (keyEnv.length === 0) fail(`${where}.keyEnv: an anthropic provider needs a key`);
    return p as unknown as AnthropicProvider;
  }
  if (p.api === "openai") {
    onlyKeys(p, ["api", "baseUrl", "keyEnv", "caps", "billingUrl", "maxTokensField", "maxOutputTokens", "maxCorpusPages"], where);
    if (typeof p.baseUrl !== "string" || !/^https?:\/\//.test(p.baseUrl)) fail(`${where}.baseUrl must be an http(s) URL`);
    if (!isRecord(p.caps) || !CAPS.every((c) => typeof (p.caps as Record<string, unknown>)[c] === "boolean")) {
      fail(`${where}.caps must set ${CAPS.join(", ")} to true or false`);
    }
    onlyKeys(p.caps, CAPS, `${where}.caps`);
    if (p.maxTokensField !== undefined && p.maxTokensField !== "max_completion_tokens" && p.maxTokensField !== "max_tokens") {
      fail(`${where}.maxTokensField must be "max_completion_tokens" or "max_tokens"`);
    }
    if (p.maxOutputTokens !== undefined && !(Number.isInteger(p.maxOutputTokens) && (p.maxOutputTokens as number) > 0)) {
      fail(`${where}.maxOutputTokens must be a positive integer`);
    }
    return p as unknown as OpenAIProvider;
  }
  return fail(`${where}.api must be "anthropic" or "openai"`);
}

export function parseInferenceConfig(input: unknown): InferenceConfig {
  if (!isRecord(input)) fail("must be a JSON object");
  onlyKeys(input, ["$doc", "providers", "features", "dev"], "(root)");
  if (!isRecord(input.providers)) fail("providers must be an object");
  const providers: Record<string, Provider> = {};
  for (const [name, p] of Object.entries(input.providers)) providers[name] = parseProvider(name, p);

  if (!isRecord(input.features)) fail("features must be an object");
  for (const name of Object.keys(input.features)) {
    if (!(FEATURES as readonly string[]).includes(name)) fail(`features.${name}: unknown feature (known: ${FEATURES.join(", ")})`);
  }
  const features = {} as InferenceConfig["features"];
  for (const name of FEATURES) {
    const f = input.features[name];
    if (!isRecord(f)) fail(`features.${name} is missing`);
    onlyKeys(f, ["provider", "model"], `features.${name}`);
    if (typeof f.provider !== "string" || !providers[f.provider]) fail(`features.${name}.provider names no provider`);
    if (typeof f.model !== "string" || !f.model.trim()) fail(`features.${name}.model must be a model id`);
    features[name] = { provider: f.provider, model: f.model };
  }

  const dev: InferenceConfig["dev"] = {};
  if (input.dev !== undefined) {
    if (!isRecord(input.dev)) fail("dev must be an object");
    for (const [name, model] of Object.entries(input.dev)) {
      if (!(FEATURES as readonly string[]).includes(name)) fail(`dev.${name}: unknown feature`);
      if (typeof model !== "string" || !model.trim()) fail(`dev.${name} must be a model id`);
      dev[name as Feature] = model;
    }
  }
  return { providers, features, dev };
}

export const INFERENCE = parseInferenceConfig(raw);

/** The model a feature runs on. `dev` is the CLI's --mode dev, the cheap tier for iterating. */
export function modelId(feature: Feature, mode: InferenceMode = "prod", config: InferenceConfig = INFERENCE): string {
  return (mode === "dev" ? config.dev[feature] : undefined) ?? config.features[feature].model;
}

export function providerFor(feature: Feature, config: InferenceConfig = INFERENCE): Provider {
  return config.providers[config.features[feature].provider];
}

// Anthropic's models take everything this app sends, so an anthropic provider declares no caps and
// gets these. Only an OpenAI-compatible endpoint — where the deployer picks the model — has to say.
const ANTHROPIC_CAPS: Caps = { vision: true, pdf: true, jsonSchema: true, tools: true };

/** What the model behind a feature can take. The server refuses past this; the browser stops asking. */
export function capsFor(feature: Feature, config: InferenceConfig = INFERENCE): Caps {
  const p = providerFor(feature, config);
  return p.api === "openai" ? p.caps : ANTHROPIC_CAPS;
}

/**
 * How many pages of the patient's reports one request to this feature's model may carry (CORPUS.md).
 *
 * Here rather than in the assembler because it is a MODEL property, not a transport one: at
 * ~1,500–3,000 tokens a page, 250 pages is 375–750 K tokens, which fits a 1 M-context model with
 * room for history and output and does not fit a 200 K one. A deployer pointing a feature at a
 * smaller model says so per provider; the default suits the models this repo ships with.
 */
export const DEFAULT_MAX_CORPUS_PAGES = 250;

export function maxCorpusPagesFor(feature: Feature, config: InferenceConfig = INFERENCE): number {
  return providerFor(feature, config).maxCorpusPages ?? DEFAULT_MAX_CORPUS_PAGES;
}
