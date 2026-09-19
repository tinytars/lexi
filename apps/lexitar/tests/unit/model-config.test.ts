import { describe, it, expect } from "vitest";
import raw from "../../inference.config.json";
import { FEATURES, INFERENCE, modelId, parseInferenceConfig, providerFor } from "../../src/lib/model-config";
import { modelFor } from "../../functions/_lib/inference/resolve";

function config(over: Record<string, unknown> = {}) {
  return { ...structuredClone(raw), ...over } as Record<string, unknown>;
}
function withProvider(p: Record<string, unknown>) {
  const c = config();
  (c.providers as Record<string, unknown>).anthropic = p;
  return c;
}

describe("inference.config.json", () => {
  it("configures every feature", () => {
    for (const f of FEATURES) expect(modelId(f)).toBeTruthy();
  });

  // The repo is public: a key typed into this file would be published.
  it("names env vars, never holds a key", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    for (const p of Object.values(INFERENCE.providers)) for (const k of p.keyEnv) expect(k).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe("parseInferenceConfig", () => {
  it("accepts the checked-in file", () => {
    expect(parseInferenceConfig(raw)).toEqual(INFERENCE);
  });

  it("rejects a key pasted in place of an env var name", () => {
    expect(() => parseInferenceConfig(withProvider({ api: "anthropic", keyEnv: ["sk-ant-api03-abc"] }))).toThrow(/env var NAMES/);
  });

  it("rejects a key field, pointing at keyEnv", () => {
    expect(() => parseInferenceConfig(withProvider({ api: "anthropic", keyEnv: ["A"], apiKey: "sk-x" }))).toThrow(/keys never go in this file/);
  });

  it("rejects an unknown provider api, feature, provider reference or field", () => {
    expect(() => parseInferenceConfig(withProvider({ api: "gemini", keyEnv: ["A"] }))).toThrow(/api must be/);
    expect(() => parseInferenceConfig(config({ features: { ...raw.features, poetry: { provider: "anthropic", model: "m" } } }))).toThrow(/unknown feature/);
    expect(() => parseInferenceConfig(config({ features: { ...raw.features, chat: { provider: "nope", model: "m" } } }))).toThrow(/names no provider/);
    expect(() => parseInferenceConfig(config({ extra: 1 }))).toThrow(/unknown field/);
  });

  it("rejects a missing feature", () => {
    const { chat: _chat, ...rest } = raw.features;
    expect(() => parseInferenceConfig(config({ features: rest }))).toThrow(/features.chat is missing/);
  });

  it("requires an openai provider to declare its capabilities", () => {
    expect(() => parseInferenceConfig(withProvider({ api: "openai", baseUrl: "http://localhost:11434/v1", keyEnv: [] }))).toThrow(/caps must set/);
    const ok = parseInferenceConfig(
      withProvider({ api: "openai", baseUrl: "http://localhost:11434/v1", keyEnv: [], caps: { vision: false, pdf: false, jsonSchema: true, tools: true }, maxTokensField: "max_tokens", maxOutputTokens: 8192 }),
    );
    expect(providerFor("chat", ok).api).toBe("openai");
  });

  it("applies dev overrides only in dev mode", () => {
    const c = parseInferenceConfig(config({ dev: { finding: "cheap" } }));
    expect(modelId("finding", "dev", c)).toBe("cheap");
    expect(modelId("finding", "prod", c)).toBe(raw.features.finding.model);
    expect(modelId("chat", "dev", c)).toBe(raw.features.chat.model);
  });
});

describe("modelFor", () => {
  it("names every env var it tried when none is set", () => {
    expect(() => modelFor({}, "finding")).toThrow('model for "finding" is not configured: set FINDING_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY');
  });

  it("falls back along keyEnv and returns the configured model", () => {
    const r = modelFor({ FINDING_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "k" }, "finding", "dev");
    expect(r.model).toBe(modelId("finding", "dev"));
    expect(typeof r.client.messages.create).toBe("function");
  });

  it("needs no key for a local provider", () => {
    const c = parseInferenceConfig(withProvider({ api: "openai", baseUrl: "http://localhost:11434/v1", keyEnv: [], caps: { vision: false, pdf: false, jsonSchema: true, tools: true } }));
    expect(modelFor({}, "chat", "prod", c).model).toBe(raw.features.chat.model);
  });
});
