// The test the whole corpus exists to pass: ask a real model, through a real corpus, about something
// that lives ONLY in a report's own pages — and get the right answer back.
//
// Every other suite proves the plumbing. `inference-corpus.test.ts` proves the right bytes are
// attached in the right order; `chat-function.test.ts` proves the route sends them. None of them can
// prove the model can actually READ them, because none of them calls a model. This does, which is
// also why it is opt-in and never in CI:
//
//   BENCH_LIVE=1 npx vitest run --config vitest.live.config.ts tests/live/corpus-answers-the-document.test.ts
//
// The facts below were chosen for one property: a structured extraction of a lab panel does not
// model any of them. A prior study's score buried in an imaging narrative, a reference interval from
// a table cell, a supplement dose from a clinic note — each is present in the document and absent
// from `SourceRecord.extraction`, so an answer can only have come from the document itself. That is
// the difference between "in sight of the reports" and "in sight of a summary of the reports".
import "../../scripts/load-creds";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { openReportCorpus, type CorpusEnv } from "../../functions/_lib/inference/corpus";
import { modelFor } from "../../functions/_lib/inference/resolve";
import { chatSystemPrompt } from "../../src/lib/chat-prompt";
import { useWorkerd } from "../support/miniflare";

const STORE = "dev";
const SLUG = "alex";
const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const w = useWorkerd({ r2: true });

it("refuses to run without BENCH_LIVE=1", () => {
  expect(process.env.BENCH_LIVE, "set BENCH_LIVE=1 — this suite makes real, billable model calls").toBe("1");
});

/** The two committed synthetic documents, stored exactly as an import would have stored them. */
async function vaultWithReports(): Promise<{ accountId: string }> {
  const accountId = crypto.randomUUID();
  await createAccount(w.db, { id: accountId, displayName: SLUG, email: `${SLUG}-${accountId}@example.com` });
  for (const name of ["synthetic-note", "synthetic-report"]) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, `${name}.pdf`)));
    const key = `${STORE}/raw/${SLUG}/${name}.pdf`;
    await w.bucket.put(key, bytes);
    await recordRawObject(w.db, key, accountId, { pages: 1, bytes: bytes.length });
  }
  return { accountId };
}

// Each is answerable from the fixture and from nothing else. `pattern` is deliberately loose about
// prose and strict about the value: the claim under test is that the model read the document, not
// that it phrased the answer a particular way.
const PROBES = [
  {
    what: "a prior study's result, mentioned in passing inside an imaging narrative",
    ask: "What was this person's coronary artery calcium score before the most recent one, and on what date was it measured?",
    pattern: /168/,
  },
  {
    what: "a reference interval, readable only by reading across a table row",
    ask: "What reference interval does the lab report print for 25-OH vitamin D, and was the result inside it?",
    pattern: /50\s*[–-]\s*125/,
  },
  {
    what: "a supplement and its dose, recorded in a clinic note rather than as a medication",
    ask: "Which supplements is this person taking, and at what doses?",
    pattern: /creatine[\s\S]{0,40}5\s*g/i,
  },
] as const;

describe("a model answering from the attached reports", () => {
  it(
    "answers from the documents themselves, not from any extraction of them",
    { timeout: 10 * 60_000 },
    async () => {
      const { accountId } = await vaultWithReports();
      const env = { DB: w.db, VAULT: w.bucket, STORE_PREFIX: STORE } as unknown as CorpusEnv;
      const { corpus, release } = await openReportCorpus(env, accountId, SLUG, { citations: true });
      release();
      expect(corpus.docCount, "the fixtures were not attached — the rest of this test would be vacuous").toBe(2);

      const { client, model } = modelFor(process.env, "chat");
      const answers: string[] = [];
      const cacheReads: number[] = [];
      // Sequential, not Promise.all: the second and third calls read the entry the first one wrote,
      // which is the same ordering the app ships (CORPUS.md §4) and a tenth of the price.
      for (const probe of PROBES) {
        const message = await client.messages.create({
          model,
          max_tokens: 1024,
          system: chatSystemPrompt("metric"),
          messages: [...corpus.turns, { role: "user", content: probe.ask }],
        });
        answers.push(message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"));
        cacheReads.push((message.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0);
      }

      for (const [i, probe] of PROBES.entries()) {
        expect(answers[i], `${probe.what}\nasked: ${probe.ask}`).toMatch(probe.pattern);
      }

      // The other half of the design, and the one that decides what it costs: every call after the
      // first must READ the corpus rather than re-send it. A breakpoint on the wrong block, or one
      // volatile byte ahead of the documents, leaves this at zero and the bill at full price.
      expect(cacheReads.slice(1).every((n) => n > 0), `cache reads per call: ${cacheReads.join(", ")}`).toBe(true);
    },
  );
});
