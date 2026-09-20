// The shipped alternative stacks, checked the way a deployer would find out they were wrong: parse
// the file, then drive every feature it configures over the wire and see whether the capability it
// DECLARES is the capability it HAS. An example that rots — a renamed feature, a cap that no longer
// matches the adapter, a key pasted in by mistake — fails here instead of after someone copies it.
//
// MODELS.md says which stack is which and what it measured; this file only proves the files work.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelFor } from "../../functions/_lib/inference/resolve";
import { classifyModelError } from "../../functions/_lib/model-errors";
import { FEATURES, capsFor, parseInferenceConfig, providerFor, type Feature, type InferenceConfig } from "../../src/lib/model-config";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai";

const DIR = join(import.meta.dirname, "..", "..", "inference.examples");
const EXAMPLES = readdirSync(DIR).filter((f) => f.endsWith(".json"));

const TINY_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=";
const TINY_PDF = "JVBERi0xLjQK";

/** Every openai provider redirected at the fake server, so the declared caps are exercised without
 *  a network, a key or a model. An anthropic provider is left alone: it is never called here. */
function against(config: InferenceConfig, baseUrl: string): InferenceConfig {
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([name, p]) => [name, p.api === "openai" ? { ...p, baseUrl } : p]),
  );
  return { ...config, providers };
}

function completion(text: string): unknown {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

async function send(config: InferenceConfig, feature: Feature, block: Anthropic.ContentBlockParam): Promise<void> {
  const { client, model } = modelFor({}, feature, "prod", config);
  await client.messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: [block] }] });
}

const IMAGE: Anthropic.ContentBlockParam = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: TINY_JPEG } };
const PDF: Anthropic.ContentBlockParam = { type: "document", source: { type: "base64", media_type: "application/pdf", data: TINY_PDF } };

describe("inference.examples", () => {
  it("ships at least one alternative to the committed default", () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
  });

  describe.each(EXAMPLES)("%s", (file) => {
    const raw = readFileSync(join(DIR, file), "utf8");
    let fake: FakeOpenAI;
    let config: InferenceConfig;

    beforeAll(async () => {
      fake = await startFakeOpenAI();
      config = against(parseInferenceConfig(JSON.parse(raw)), fake.baseUrl);
    });
    afterAll(() => fake.close());

    it("parses as an inference config", () => {
      expect(() => parseInferenceConfig(JSON.parse(raw))).not.toThrow();
    });

    // This repo is public. The validator refuses key-LIKE field names; this refuses key-like values,
    // which is the mistake that actually publishes a secret.
    it("carries env var names, never a credential", () => {
      expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
      expect(raw).not.toMatch(/Bearer\s+\S/i);
    });

    it.each(FEATURES)("%s declares a capability the adapter agrees with", async (feature) => {
      if (providerFor(feature, config).api !== "openai") {
        // An anthropic provider takes everything this app sends, so there is nothing to disagree on.
        expect(capsFor(feature, config)).toEqual({ vision: true, pdf: true, jsonSchema: true, tools: true });
        return;
      }
      const caps = capsFor(feature, config);

      fake.reply({ json: completion("ok") });
      const image = send(config, feature, IMAGE);
      if (caps.vision) {
        await expect(image).resolves.toBeUndefined();
        const parts = fake.requests.at(-1)?.body.messages as { content: { type: string }[] }[];
        expect(parts.at(-1)?.content.some((p) => p.type === "image_url")).toBe(true);
      } else {
        // Refused before a byte is spent, and as a 422 the browser can act on — never a 500.
        await expect(image).rejects.toThrow(/does not support images/);
        await expect(image.catch((e) => classifyModelError(e))).resolves.toEqual({ status: 422, errorCode: "model_unsupported" });
      }

      fake.reply({ json: completion("ok") });
      const pdf = send(config, feature, PDF);
      if (caps.pdf) await expect(pdf).resolves.toBeUndefined();
      else await expect(pdf).rejects.toThrow(/does not support PDF documents/);
    });
  });
});
