// The corpus on a provider that is not Anthropic. Everything else about this feature is allowed to
// be an Anthropic optimization; the corpus itself is not, because "every inference answers from the
// documents" is a claim this app makes about any configured stack (DPGA indicator 4, MODELS.md).
//
// So the corpus here is the REAL one — assembled from real R2 and real D1 by the same function the
// routes call — and it is sent over a real HTTP connection to a server speaking OpenAI's
// /chat/completions. A hand-written turn would pin the adapter while the assembler drifted out from
// under it, which is precisely the direction this has to hold.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { openReportCorpus, CORPUS_ACK, CORPUS_PREAMBLE, type CorpusEnv } from "../../functions/_lib/inference/corpus";
import { openAIClient } from "../../functions/_lib/inference/openai";
import { classifyModelError, ModelUnsupportedError } from "../../functions/_lib/model-errors";
import type { OpenAIProvider } from "../../src/lib/model-config";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai";
import { useWorkerd } from "../support/miniflare";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });

let fake: FakeOpenAI;
beforeAll(async () => (fake = await startFakeOpenAI()));
afterAll(() => fake.close());

const provider = (pdf: boolean): OpenAIProvider => ({
  api: "openai",
  baseUrl: fake.baseUrl,
  keyEnv: [],
  caps: { vision: true, pdf, jsonSchema: true, tools: true },
});

const COMPLETION = { id: "c1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

/** Two reports under one client, named so that R2 key order and attachment order can disagree. */
async function twoReports(): Promise<Anthropic.MessageParam[]> {
  const who = crypto.randomUUID();
  await createAccount(w.db, { id: who, displayName: "alex", email: `alex-${who}@example.com` });
  for (const [file, body] of [["a-labs.pdf", "%PDF-1.4 labs"], ["b-scan.pdf", "%PDF-1.4 scan"]]) {
    const key = `${STORE}/raw/alex/${file}`;
    const bytes = new TextEncoder().encode(body);
    await w.bucket.put(key, bytes);
    await recordRawObject(w.db, key, who, { pages: 1, bytes: bytes.length });
  }
  const env = { DB: w.db, VAULT: w.bucket, STORE_PREFIX: STORE } as unknown as CorpusEnv;
  const { corpus, release } = await openReportCorpus(env, who, "alex", { citations: true });
  release();
  return corpus.turns;
}

const send = (turns: Anthropic.MessageParam[], pdf: boolean) =>
  openAIClient(provider(pdf), undefined).messages.create({
    model: "m",
    max_tokens: 16,
    messages: [...turns, { role: "user", content: "what does the scan say?" }],
  });

describe("the corpus through an OpenAI-compatible provider", () => {
  it("arrives as file parts, in the same order, with the documents' own bytes", async () => {
    const turns = await twoReports();
    fake.reply({ json: COMPLETION });

    await send(turns, true);

    const messages = fake.requests.at(-1)!.body.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0].content).toEqual([
      { type: "file", file: { filename: "a-labs.pdf", file_data: `data:application/pdf;base64,${btoa("%PDF-1.4 labs")}` } },
      { type: "file", file: { filename: "b-scan.pdf", file_data: `data:application/pdf;base64,${btoa("%PDF-1.4 scan")}` } },
      { type: "text", text: CORPUS_PREAMBLE },
    ]);
    expect(messages[1].content).toBe(CORPUS_ACK);
  });

  // The adapter's header says it drops cache_control, and nothing downstream reads the field — so
  // the only thing keeping it from being "helpfully" forwarded one day is this assertion. An
  // OpenAI-compatible server handed an unknown key answers 400, i.e. the corpus stops working there.
  it("drops the cache breakpoint rather than forwarding an Anthropic-only field", async () => {
    const turns = await twoReports();
    const docs = turns[0].content as Anthropic.ContentBlockParam[];
    expect((docs[1] as Anthropic.DocumentBlockParam).cache_control).toEqual({ type: "ephemeral" });
    fake.reply({ json: COMPLETION });

    await send(turns, true);

    expect(JSON.stringify(fake.requests.at(-1)!.body)).not.toContain("cache_control");
    expect(JSON.stringify(fake.requests.at(-1)!.body)).not.toContain("ephemeral");
  });

  // Refuse, never degrade: a text-only provider does not get the question with the reports quietly
  // left out of it. 422 is the status the browser already knows how to show.
  it("refuses on a provider that cannot take PDFs, before anything is sent", async () => {
    const turns = await twoReports();
    const before = fake.requests.length;

    const call = send(turns, false);

    await expect(call).rejects.toBeInstanceOf(ModelUnsupportedError);
    await expect(call.catch((e) => classifyModelError(e))).resolves.toEqual({ status: 422, errorCode: "model_unsupported" });
    expect(fake.requests.length).toBe(before);
  });
});
