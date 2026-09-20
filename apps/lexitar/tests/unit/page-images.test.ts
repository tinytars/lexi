import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// pdfjs has no business in a unit test, and needsPageImages is a question about config, not about
// rasterising — same module-boundary mock attachment-extract-on-attach.test.ts uses.
vi.mock("@tinytars/frame/pdf-render", () => ({ openPdf: vi.fn() }));

import { readDocument } from "@pablotech/akesi/document-read";
import { openAIClient } from "../../functions/_lib/inference/openai";
import { classifyModelError, ModelUnsupportedError } from "../../functions/_lib/model-errors";
import { validatePageImages } from "../../functions/_lib/page-images";
import { needsPageImages } from "../../src/lib/pdf-pages-for-model";
import { FEATURES, type Caps, type InferenceConfig, type OpenAIProvider } from "../../src/lib/model-config";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai";

const ALL: Caps = { vision: true, pdf: true, jsonSchema: true, tools: true };

function configFor(provider: { api: "openai"; baseUrl: string; keyEnv: string[]; caps: Caps } | { api: "anthropic"; keyEnv: string[] }): InferenceConfig {
  const features = Object.fromEntries(FEATURES.map((f) => [f, { provider: "p", model: "m" }])) as InferenceConfig["features"];
  return { providers: { p: provider }, features, dev: {} };
}
const openai = (caps: Partial<Caps>) => configFor({ api: "openai", baseUrl: "http://local/v1", keyEnv: [], caps: { ...ALL, ...caps } });

describe("needsPageImages", () => {
  it.each(["extract", "document"] as const)("renders %s to pages for a model that can see but cannot take a PDF", (feature) => {
    expect(needsPageImages(feature, openai({ pdf: false }))).toBe(true);
  });

  it("sends the PDF itself when the model reads PDFs natively", () => {
    expect(needsPageImages("extract", openai({}))).toBe(false);
  });

  it("does not render for a model that can do neither — that refusal is the relay's to make", () => {
    expect(needsPageImages("extract", openai({ pdf: false, vision: false }))).toBe(false);
  });

  it("never renders for the Anthropic default", () => {
    expect(needsPageImages("document", configFor({ api: "anthropic", keyEnv: ["ANTHROPIC_API_KEY"] }))).toBe(false);
  });
});

describe("validatePageImages", () => {
  it("accepts a well-formed list, in order, keeping only the two fields the model call uses", () => {
    expect(
      validatePageImages([
        { base64: "AAA", mediaType: "image/jpeg", dpi: 150 },
        { base64: "BBB", mediaType: "image/png" },
      ]),
    ).toEqual([
      { base64: "AAA", mediaType: "image/jpeg" },
      { base64: "BBB", mediaType: "image/png" },
    ]);
  });

  it.each([
    ["absent", undefined],
    ["not a list", { base64: "A", mediaType: "image/jpeg" }],
    ["empty", []],
    ["a list of non-objects", ["AAA"]],
    ["missing base64", [{ mediaType: "image/jpeg" }]],
    ["an empty base64", [{ base64: "", mediaType: "image/jpeg" }]],
    ["a non-image media type", [{ base64: "A", mediaType: "application/pdf" }]],
    ["one bad page among good ones", [{ base64: "A", mediaType: "image/jpeg" }, { base64: "B", mediaType: "text/html" }]],
  ])("rejects %s", (_what, raw) => {
    expect(validatePageImages(raw)).toBeNull();
  });
});

describe("a vision-only model, over the wire", () => {
  let fake: FakeOpenAI;
  beforeAll(async () => (fake = await startFakeOpenAI()));
  afterAll(() => fake.close());

  const VISION_ONLY: Caps = { ...ALL, pdf: false };
  const client = () =>
    openAIClient({ api: "openai", baseUrl: fake.baseUrl, keyEnv: [], caps: VISION_ONLY } as OpenAIProvider, undefined);
  const READING = { documentKind: "Lab report", isMedicalReport: true, notReportReason: "", text: "IMPRESSION: unremarkable." };

  it("reaches the model as labelled image parts, and reads back", async () => {
    fake.reply({ json: { id: "c1", model: "m", choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: "stop" }], usage: {} } });
    const reading = await readDocument(
      client(),
      { pageImages: [{ base64: "AAA", mediaType: "image/jpeg" }, { base64: "BBB", mediaType: "image/jpeg" }] },
      "report.pdf",
      "m",
    );
    expect(reading.text).toBe(READING.text);

    const messages = fake.requests.at(-1)!.body.messages as { content: { type: string; text?: string }[] }[];
    const content = messages.at(-1)!.content;
    expect(content.slice(0, 4)).toEqual([
      { type: "text", text: "Page 1 of 2:" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      { type: "text", text: "Page 2 of 2:" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
    ]);
    expect(content.at(-1)!.text).toContain("report.pdf");
  });

  it("refuses the same document as a PDF, before a request is made, as a clean 422", async () => {
    const before = fake.requests.length;
    const err = await readDocument(client(), { pdfBase64: "JVBERi0x" }, "report.pdf", "m").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnsupportedError);
    expect(classifyModelError(err)).toEqual({ status: 422, errorCode: "model_unsupported" });
    expect(fake.requests.length).toBe(before);
  });
});
