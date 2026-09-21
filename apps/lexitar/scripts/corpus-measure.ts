// W77 — what a patient's report corpus actually costs in tokens, measured rather than reasoned.
//
// CORPUS.md's cost section may carry no estimated figure: a page of a scanned lab report and a page
// of a text PDF differ by more than 2x, so a tokens-per-page midpoint is a number that looks
// measured and is not. This counts the real documents through the real tokenizer.
//
//   npm run corpus:measure           # every namespace in this worktree's environment
//   npm run corpus:measure -- alex   # one
//
// `messages.count_tokens` is not billed and produces no completion, so this spends nothing — which
// is why measuring is allowed to precede the decision about whether to turn the corpus on.
//
// Like every script here it targets THIS WORKTREE's environment (scripts/target.ts). It reads the
// same rows the assembler reads and skips a namespace holding an unmeasured PDF, because that is a
// namespace the corpus itself refuses (functions/_lib/inference/corpus.ts).

import "./load-creds";
import Anthropic from "@anthropic-ai/sdk";
import { d1, q, D1 } from "./d1-remote";
import { LIVE_BUCKET, getObject, resolveStore } from "./vault-sync";
import { isMain } from "./is-main";
import { CORPUS_PREAMBLE, CORPUS_ACK } from "../src/lib/corpus-prompt";
import { chatSystemPrompt } from "../src/lib/chat-prompt";
import { GET_MARKER_READINGS_TOOL } from "../src/lib/chat-tools";
import { modelId, providerFor } from "../src/lib/model-config";

const STORE = resolveStore();
const FEATURE = "chat" as const;

interface Row { r2_key: string; pages: number | null }

/** The namespace segment of `{store}/raw/{clientId}/{file}`, read positionally so it holds on any store. */
export const clientOf = (key: string): string => key.split("/")[2];

export function groupByClient(rows: Row[]): Map<string, Row[]> {
  const byClient = new Map<string, Row[]>();
  for (const row of rows) {
    const client = clientOf(row.r2_key);
    const group = byClient.get(client) ?? [];
    group.push(row);
    byClient.set(client, group);
  }
  return byClient;
}

function anthropicClient(): Anthropic {
  const provider = providerFor(FEATURE);
  if (provider.api !== "anthropic") throw new Error(`"${FEATURE}" is not on an Anthropic provider; count_tokens has no equivalent`);
  const apiKey = provider.keyEnv.map((n) => process.env[n]).find((v) => v);
  if (!apiKey) throw new Error(`set ${provider.keyEnv.join(" or ")}`);
  return new Anthropic({ apiKey });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  const rows = await d1<Row>(
    `SELECT r2_key, pages FROM raw_objects WHERE lower(r2_key) LIKE '%.pdf' AND r2_key LIKE ${q(`${STORE}/raw/%`)} ORDER BY r2_key`,
  );
  const model = modelId(FEATURE, "prod");
  process.stdout.write(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")\nModel:  ${model}\n\n`);

  const anthropic = anthropicClient();
  const totals = { pages: 0, tokens: 0 };

  for (const [client, docs] of groupByClient(rows)) {
    if (only.length > 0 && !only.includes(client)) continue;
    const unmeasured = docs.filter((d) => d.pages === null).length;
    if (unmeasured > 0) {
      // The assembler refuses this whole namespace, so a token count for the readable part of it
      // would describe a request that can never be sent.
      process.stdout.write(`${client}: skipped — ${unmeasured} of ${docs.length} PDFs unmeasured\n`);
      continue;
    }

    const blocks: Anthropic.DocumentBlockParam[] = [];
    for (const { r2_key } of docs) {
      const bytes = await getObject(LIVE_BUCKET, r2_key);
      if (!bytes) throw new Error(`${r2_key} is in raw_objects but not in R2`);
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64(bytes) },
        title: r2_key.slice(`${STORE}/raw/${client}/`.length),
        citations: { enabled: true },
      });
    }

    // The whole chat prefix, not the documents alone: tools and system sit AHEAD of the corpus in
    // the cached prefix, so they are part of what every write pays for.
    const { input_tokens } = await anthropic.messages.countTokens({
      model,
      system: chatSystemPrompt("metric"),
      tools: [GET_MARKER_READINGS_TOOL],
      messages: [
        { role: "user", content: [...blocks, { type: "text", text: CORPUS_PREAMBLE }] },
        { role: "assistant", content: CORPUS_ACK },
      ],
    });

    const pages = docs.reduce((n, d) => n + (d.pages ?? 0), 0);
    totals.pages += pages;
    totals.tokens += input_tokens;
    process.stdout.write(
      `${client}: ${docs.length} PDFs, ${pages} pages, ${input_tokens.toLocaleString()} tokens ` +
        `(${Math.round(input_tokens / pages).toLocaleString()}/page)\n`,
    );
  }

  if (totals.pages === 0) return;
  process.stdout.write(`\nAll measured: ${totals.pages} pages, ${totals.tokens.toLocaleString()} tokens, ${Math.round(totals.tokens / totals.pages).toLocaleString()}/page\n`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`\n${(e as Error).message}\n`);
    process.exit(1);
  });
}
