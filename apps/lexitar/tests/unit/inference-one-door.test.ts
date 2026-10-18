// Real R2 and real D1 again: what this file pins is that a model and a person's reports are
// obtained together, and "together" is only meaningful against the storage the reports live in.
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import raw from "../../inference.config.json";
import { capsFor, parseInferenceConfig, FEATURES, type Feature } from "../../src/lib/model-config";
import { ModelUnsupportedError } from "../../functions/_lib/model-errors";
import { withAttachedModel, unattachedModelFor, UNATTACHED_FEATURES, type AttachedEnv, type AttachedFeature, type AttachedModel } from "../../functions/_lib/inference/attach";
import type { InferenceConfig } from "../../src/lib/model-config";
import type { Subject } from "../../functions/_lib/inference/subject";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { useWorkerd } from "../support/miniflare";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });

const ATTACHED = FEATURES.filter((f): f is AttachedFeature => !(UNATTACHED_FEATURES as readonly Feature[]).includes(f));

const env = (reports?: string) =>
  ({ ANTHROPIC_API_KEY: "test-key", DB: w.db, VAULT: w.bucket, STORE_PREFIX: STORE, REPORTS: reports }) as unknown as AttachedEnv;

/** An env whose storage throws, so "did not assemble a corpus" is a fact rather than an assertion. */
const noStorage = (reports?: string) => {
  const boom = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } });
  return { ANTHROPIC_API_KEY: "test-key", DB: boom, VAULT: boom, STORE_PREFIX: STORE, REPORTS: reports } as unknown as AttachedEnv;
};

async function clientWithOneReport(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: slug, email: `${slug}-${id}@example.com` });
  const key = `${STORE}/raw/${slug}/report.pdf`;
  await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 one"));
  await recordRawObject(w.db, key, id, { pages: 3, bytes: 12 });
  return id;
}

/** What the door hands a route, lifted out of its scope: these tests pin WHAT comes back, where
 *  attach-scope.test.ts pins how long the isolate budget it reserved is held for. */
const attachedModelFor = (env: AttachedEnv, feature: AttachedFeature, who: Subject, config?: InferenceConfig): Promise<AttachedModel> =>
  withAttachedModel(env, feature, who, async (attached) => attached, config);

const firstDoc = (turns: Anthropic.MessageParam[]): Anthropic.DocumentBlockParam =>
  (turns[0].content as Anthropic.ContentBlockParam[])[0] as Anthropic.DocumentBlockParam;

describe("the configured stack can carry what it is asked to carry", () => {
  // Tomorrow's feature is attached by default: adding one to FEATURES puts it here automatically,
  // and it fails this until its provider is one that can take a PDF.
  it("gives every attached feature a provider that declares pdf", () => {
    const withoutPdf = ATTACHED.filter((f) => !capsFor(f).pdf);
    expect(withoutPdf).toEqual([]);
    expect(ATTACHED.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses rather than answering from less when the provider cannot take PDFs", async () => {
    const textOnly = parseInferenceConfig({
      ...structuredClone(raw),
      providers: Object.fromEntries(
        Object.keys((raw as { providers: Record<string, unknown> }).providers).map((name) => [
          name,
          { api: "openai", baseUrl: "http://localhost:1234/v1", keyEnv: [], caps: { vision: false, pdf: false, jsonSchema: true, tools: true } },
        ]),
      ),
    });
    const who = { accountId: await clientWithOneReport("alex"), clientId: "alex", rawKeys: {} };

    await expect(attachedModelFor(env("always"), "chat", who, textOnly)).rejects.toBeInstanceOf(ModelUnsupportedError);
  });
});

describe("REPORTS", () => {
  it("attaches the client's reports when it is on", async () => {
    const who = { accountId: await clientWithOneReport("alex"), clientId: "alex", rawKeys: {} };

    const { corpus } = await attachedModelFor(env("always"), "chat", who);

    expect(corpus.docCount).toBe(1);
    expect(corpus.turns).toHaveLength(2);
  });

  // An unset flag is a deployment that never asked for this: it keeps the behaviour, and the bill,
  // it had before the feature existed.
  it("attaches nothing, and reads no storage at all, when it is unset", async () => {
    const { corpus } = await attachedModelFor(noStorage(), "chat", { accountId: "anyone", clientId: "alex", rawKeys: {} });

    expect(corpus).toEqual({ turns: [], docCount: 0, pageCount: 0, byteCount: 0 });
  });

  it("attaches nothing when it is explicitly off", async () => {
    const { corpus } = await attachedModelFor(noStorage("never"), "chat", { accountId: "anyone", clientId: "alex", rawKeys: {} });

    expect(corpus.docCount).toBe(0);
  });

  // A typo here would silently serve partial-knowledge answers to every patient, which is the one
  // outcome this design refuses — so it is loud instead.
  it("throws on any other value rather than quietly falling back to off", async () => {
    await expect(attachedModelFor(noStorage("Always"), "chat", { accountId: "a", clientId: "alex", rawKeys: {} })).rejects.toThrow(/REPORTS/);
  });
});

describe("citations", () => {
  it("asks for page cites on a feature that answers in prose", async () => {
    const who = { accountId: await clientWithOneReport("alex"), clientId: "alex", rawKeys: {} };

    const { corpus } = await attachedModelFor(env("always"), "chat", who);

    expect(firstDoc(corpus.turns).citations).toEqual({ enabled: true });
  });

  // output_config.format and citations are mutually exclusive; ranges and markerGroups use the
  // former, so asking for both would be a 400 in front of a real question.
  it("omits them on the features that pin their output shape", async () => {
    const who = { accountId: await clientWithOneReport("alex"), clientId: "alex", rawKeys: {} };

    for (const feature of ["ranges", "markerGroups"] as const) {
      const { corpus } = await attachedModelFor(env("always"), feature, who);
      expect(firstDoc(corpus.turns).citations, feature).toBeUndefined();
    }
  });
});

describe("the features that deliberately carry no corpus", () => {
  it("resolves a model without a client, and without reading storage", () => {
    for (const feature of UNATTACHED_FEATURES) {
      expect(unattachedModelFor(noStorage("always"), feature).model).toBeTruthy();
    }
  });
});
