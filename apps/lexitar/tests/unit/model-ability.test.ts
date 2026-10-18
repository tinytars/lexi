import { describe, it, expect, vi, afterEach } from "vitest";
import raw from "../../inference.config.json";
import { parseInferenceConfig, capsFor, type Caps } from "../../src/lib/model-config";
import { ABILITY_UNAVAILABLE, supports, unsupportedNote } from "../../src/lib/model-ability";
import { AI_ERROR_MESSAGES, describeAiError } from "../../src/lib/ai-error";
import { extractReport } from "../../src/lib/extract-client";

// A deployment whose every feature runs on one OpenAI-compatible model with these caps.
function deployment(caps: Caps) {
  const c = structuredClone(raw) as Record<string, unknown>;
  c.providers = { only: { api: "openai", baseUrl: "http://localhost:11434/v1", keyEnv: [], caps } };
  c.features = Object.fromEntries(
    Object.entries(raw.features).map(([f, v]) => [f, { provider: "only", model: (v as { model: string }).model }]),
  );
  return parseInferenceConfig(c);
}
const TEXT_ONLY: Caps = { vision: false, pdf: false, jsonSchema: true, tools: true };

describe("capsFor", () => {
  it("gives an anthropic-backed feature every capability, since it declares none", () => {
    expect(capsFor("extract")).toEqual({ vision: true, pdf: true, jsonSchema: true, tools: true });
  });

  it("reads an openai provider's declared caps", () => {
    expect(capsFor("chat", deployment(TEXT_ONLY))).toEqual(TEXT_ONLY);
  });
});

describe("supports", () => {
  it("refuses photos and documents on a text-only model", () => {
    const c = deployment(TEXT_ONLY);
    expect(supports("chat", "photos", c)).toBe(false);
    expect(supports("extract", "documents", c)).toBe(false);
    expect(unsupportedNote("extract", "documents", c)).toBe(ABILITY_UNAVAILABLE.documents);
  });

  // The whole reason "documents" is an OR: a vision model reads the pages as images.
  it("allows documents on a vision model with no native PDF input", () => {
    const c = deployment({ ...TEXT_ONLY, vision: true });
    expect(supports("extract", "documents", c)).toBe(true);
    expect(supports("chat", "photos", c)).toBe(true);
    expect(unsupportedNote("extract", "documents", c)).toBeNull();
  });

  it("allows documents but not photos on a PDF-capable model that cannot see", () => {
    const c = deployment({ ...TEXT_ONLY, pdf: true });
    expect(supports("document", "documents", c)).toBe(true);
    expect(supports("treatmentImage", "photos", c)).toBe(false);
  });
});

describe("extractReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The import path used to throw a bare Error, so describeAiError fell through to the relay's raw
  // sentence and the code was lost — the one failure mode a deployer most needs named.
  it("throws an AiError the shared renderer can name", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "the configured model does not support PDF documents", errorCode: "model_unsupported" }), { status: 422 }),
    );
    const err = await extractReport(new Uint8Array([1, 2, 3]), "r.pdf", { dob: "1980-01-01", gender: "female" }).catch((e) => e);
    expect(describeAiError(err)).toBe(AI_ERROR_MESSAGES.model_unsupported);
  });
});
