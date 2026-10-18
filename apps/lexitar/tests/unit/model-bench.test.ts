import { describe, it, expect, afterEach } from "vitest";
import { runProbe, summarize } from "@pablotech/akesi/benchmarks/model-portability";
import { probesFor, sourceFor, table } from "../../scripts/model-bench";
import { FEATURES, type Caps, type InferenceConfig, type Provider } from "../../src/lib/model-config";
import { modelFor } from "../../functions/_lib/inference/resolve";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai";

// The scoring loop, proven before it is billed. Every test here drives the SHIPPED path — the real
// prompt builder, the real validator, the real OpenAI adapter over a real socket — and scripts only
// what the model says back.

const ALL: Caps = { vision: true, pdf: true, jsonSchema: true, tools: true };
const caps = (over: Partial<Caps>): Caps => ({ ...ALL, ...over });

function configFor(provider: Provider): InferenceConfig {
  const features = Object.fromEntries(FEATURES.map((f) => [f, { provider: "p", model: "m" }])) as InferenceConfig["features"];
  return { providers: { p: provider }, features, dev: {} };
}

const openai = (over: Partial<Caps>, baseUrl = "http://127.0.0.1:1/v1"): InferenceConfig =>
  configFor({ api: "openai", baseUrl, keyEnv: [], caps: caps(over) });

describe("sourceFor — the route a document takes is the provider's declaration, not a guess", () => {
  it("sends the PDF itself to a model that declares it takes one", async () => {
    const source = await sourceFor("extract", "synthetic-report", openai({}));
    // "JVBERi" is "%PDF-" in base64: the committed fixture, not a re-encoding of something else.
    expect(source).toMatchObject({ pdfBase64: expect.stringMatching(/^JVBERi/) });
  });

  it("sends the rendered page to a model that can see but cannot take a PDF", async () => {
    const source = await sourceFor("extract", "synthetic-report", openai({ pdf: false }));
    expect(source).toEqual({ pageImages: [{ base64: expect.stringMatching(/^\/9j\//), mediaType: "image/jpeg" }] });
  });

  it("returns nothing at all for a model that declares neither — the run is skipped, not billed", async () => {
    expect(await sourceFor("extract", "synthetic-report", openai({ pdf: false, vision: false }))).toBeNull();
  });

  it("takes an anthropic provider at its word that it can do both", async () => {
    const source = await sourceFor("document", "synthetic-note", configFor({ api: "anthropic", keyEnv: ["K"] }));
    expect(source).toMatchObject({ pdfBase64: expect.stringMatching(/^JVBERi/) });
  });
});

describe("probesFor", () => {
  it("reports which route each document took, so a row cannot be read without it", async () => {
    const { probes, routes, skipped } = await probesFor(["extract", "document"], openai({ pdf: false }));
    expect(probes.map((p) => p.feature)).toEqual(["extract", "document"]);
    expect(routes).toEqual(["extract: page images", "document/synthetic-report: page images", "document/synthetic-note: page images"]);
    expect(skipped).toEqual([]);
  });

  it("builds no probe for a feature the configured model has already declared it cannot do", async () => {
    const { probes, skipped } = await probesFor(["extract", "document"], openai({ pdf: false, vision: false }));
    expect(probes).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatch(/declares neither pdf nor vision/);
  });

  it("never builds the expensive probe unless it was named", async () => {
    const { probes } = await probesFor(["ranges", "extract", "document", "treatmentText"], openai({}));
    expect(probes.map((p) => p.feature)).not.toContain("finding");
  });
});

const VALID_REPORT = {
  studyType: "Comprehensive metabolic and lipid panel",
  diseases: [{ date: "2026-02-09", diagnostic: "CAC 212", summary: "Mixed proximal LAD plaque.", confidence: 0.9 }],
  comorbidities: [],
  priorComparisons: [{ marker: "Coronary artery calcium (CAC) score", priorValue: 168, priorDate: "2024-01-22", currentValue: 212, unit: "", confidence: 0.9 }],
  markers: [{ marker: "Total protein", value: 68, unit: "g/L", date: "2026-02-14", group: "Chemistry", confidence: 0.98 }],
  isMedicalReport: true,
};

const completion = (payload: unknown) => ({
  json: { choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }], usage: {} },
});

describe("the scored loop, over the wire", () => {
  let fake: FakeOpenAI;
  afterEach(async () => await fake?.close());

  it("scores a report the validator accepts as one pass on the first attempt", async () => {
    fake = await startFakeOpenAI();
    const config = openai({ pdf: false }, fake.baseUrl);
    const { probes } = await probesFor(["extract"], config);
    fake.reply(completion(VALID_REPORT));

    const { client, model } = modelFor({}, "extract", "prod", config);
    const score = summarize(await runProbe(client, model, probes[0]), probes[0]);

    expect(score).toMatchObject({ feature: "extract", n: 1, passed: 1, passRate: 1, firstAttemptPassRate: 1, meanAttempts: 1 });
    expect(score.rejections).toEqual([]);
    // The page image really did go up as an image part — the route the row claims.
    const content = fake.requests.at(-1)!.body.messages as { content: { type: string }[] }[];
    expect(content.at(-1)!.content.some((c) => c.type === "image_url")).toBe(true);
  });

  it("scores a refused document as a failure, with the validator's own reason bucketed", async () => {
    fake = await startFakeOpenAI();
    const config = openai({ pdf: false }, fake.baseUrl);
    const { probes } = await probesFor(["extract"], config);
    fake.reply(completion({ ...VALID_REPORT, isMedicalReport: false, notReportReason: "it is a flyer" }));

    const { client, model } = modelFor({}, "extract", "prod", config);
    const score = summarize(await runProbe(client, model, probes[0]), probes[0]);

    expect(score).toMatchObject({ n: 1, passed: 0, passRate: 0 });
    expect(score.rejections[0].bucket).toBe("not a report");
    expect(score.rejections[0].example).toMatch(/flyer/);
  });

  it("does not read an unreachable server as a model that answers badly", async () => {
    const config = openai({ pdf: false });
    const { probes } = await probesFor(["extract"], config);
    const { client, model } = modelFor({}, "extract", "prod", config);
    const score = summarize(await runProbe(client, model, probes[0]), probes[0]);

    expect(score.passed).toBe(0);
    expect(score.rejections[0].bucket).toBe("unreachable");
  });
});

describe("table", () => {
  it("prints the interval and the commonest rejection next to every rate", () => {
    const rendered = table([
      { feature: "extract", model: "m", n: 4, passed: 3, passRate: 0.75, ci: [0.3, 0.95], firstAttemptPassRate: 0.5, meanAttempts: 1.5, medianMs: 2400, rejections: [{ bucket: "wrong unit", count: 2, example: "…" }] },
    ]);
    expect(rendered).toContain("| extract | `m` | 4 | 3/4 | [0.30, 0.95] | 50% | 1.50 | 2.4 | wrong unit (2) |");
  });
});
