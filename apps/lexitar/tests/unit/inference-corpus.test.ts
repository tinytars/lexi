// Real R2 and real D1 on both hosts (Miniflare and the Node adapters), because every property this
// file pins is a property of what those two actually hold: which keys exist, what order they come
// back in, and whether a page count is recorded. A double that answers whatever the assembler asks
// would pass while the corpus silently went partial, which is the one failure this design forbids.
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { openReportCorpus, type Corpus, type CorpusEnv, MAX_CORPUS_BYTES, MAX_CORPUS_DOCS, CORPUS_ACK, CORPUS_PREAMBLE } from "../../functions/_lib/inference/corpus";
import {
  CorpusBusyError,
  CorpusDeniedError,
  CorpusKeyError,
  CorpusMissingError,
  CorpusTooLargeError,
  CorpusUnmeasuredError,
} from "../../functions/_lib/inference/corpus-errors";
import { useWorkerd } from "../support/miniflare";
import { sealRaw } from "../../src/lib/raw-cipher";
import { bytesToBase64 } from "../../src/lib/base64";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });
const env = () => ({ DB: w.db, VAULT: w.bucket, STORE_PREFIX: STORE }) as unknown as CorpusEnv;

const PDF = (marker: string) => new TextEncoder().encode(`%PDF-1.4 ${marker}`);

async function account(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: name, email: `${name}-${id}@example.com` });
  return id;
}

/** An object in R2 plus the ownership row the raw routes would have written for it. */
async function store(owner: string, slug: string, file: string, opts: { pages?: number; bytes?: Uint8Array } = {}) {
  const key = `${STORE}/raw/${slug}/${file}`;
  const bytes = opts.bytes ?? PDF(file);
  await w.bucket.put(key, bytes);
  await recordRawObject(w.db, key, owner, { ...(opts.pages !== undefined && { pages: opts.pages }), bytes: bytes.length });
  return key;
}

/** The count-only backfill: a page count recorded and no byte size — the row shape that cannot be
 *  admitted on its true size, because nobody has measured it yet. */
async function storeUnmeasured(owner: string, slug: string, file: string, pages: number) {
  const key = `${STORE}/raw/${slug}/${file}`;
  await w.bucket.put(key, PDF(file));
  await recordRawObject(w.db, key, owner, { pages });
  return key;
}

/** The corpus alone, its isolate reservation released immediately — what every test outside the
 *  admission-gate block below is asserting about. The gate's own tests hold the scope open instead. */
async function corpusOf(...args: Parameters<typeof openReportCorpus>): Promise<Corpus> {
  const { corpus, release } = await openReportCorpus(...args);
  release();
  return corpus;
}

const docsOf = (turns: Anthropic.MessageParam[]): Anthropic.DocumentBlockParam[] =>
  (turns[0]?.content as Anthropic.ContentBlockParam[] | undefined)?.flatMap((b) => (b.type === "document" ? [b] : [])) ?? [];

describe("openReportCorpus", () => {
  it("attaches every PDF in the namespace and nothing else", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 3 });
    await store(who, "alex", "scan.pdf", { pages: 2 });
    await store(who, "alex", "readings.xlsx", { pages: undefined });
    await store(who, "alex", "bottle.jpg", { pages: undefined });

    const corpus = await corpusOf(env(), who, "alex", { citations: true });

    expect(corpus.docCount).toBe(2);
    expect(corpus.pageCount).toBe(5);
    expect(docsOf(corpus.turns).map((d) => d.title)).toEqual(["labs.pdf", "scan.pdf"]);
  });

  it("frames the documents as background and closes the prefix on a message boundary", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1 });

    const { turns } = await corpusOf(env(), who, "alex", { citations: true });

    expect(turns).toHaveLength(2);
    const first = turns[0].content as Anthropic.ContentBlockParam[];
    expect(first[first.length - 1]).toEqual({ type: "text", text: CORPUS_PREAMBLE });
    expect(turns[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
  });

  it("orders documents by key, whatever order they were written in", async () => {
    const who = await account("alex");
    await store(who, "alex", "zebra.pdf", { pages: 1 });
    await store(who, "alex", "apple.pdf", { pages: 1 });
    await store(who, "alex", "middle.pdf", { pages: 1 });

    const corpus = await corpusOf(env(), who, "alex", { citations: true });

    expect(docsOf(corpus.turns).map((d) => d.title)).toEqual(["apple.pdf", "middle.pdf", "zebra.pdf"]);
  });

  // The corpus is a prompt-cache prefix: two calls that differ by one byte pay two full writes
  // instead of a write and a read. That is the whole cost argument, so it is pinned as behaviour.
  it("builds a byte-identical prefix on two calls", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 2 });
    await store(who, "alex", "scan.pdf", { pages: 1 });

    const a = await corpusOf(env(), who, "alex", { citations: true });
    const b = await corpusOf(env(), who, "alex", { citations: true });

    expect(JSON.stringify(a.turns)).toBe(JSON.stringify(b.turns));
  });

  it("marks the last document and only the last, so the preamble can be edited freely", async () => {
    const who = await account("alex");
    await store(who, "alex", "a.pdf", { pages: 1 });
    await store(who, "alex", "b.pdf", { pages: 1 });
    await store(who, "alex", "c.pdf", { pages: 1 });

    const docs = docsOf((await corpusOf(env(), who, "alex", { citations: true })).turns);

    expect(docs.map((d) => d.cache_control)).toEqual([undefined, undefined, { type: "ephemeral" }]);
  });

  it("asks for citations only when the feature can take them", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1 });

    const cited = await corpusOf(env(), who, "alex", { citations: true });
    const plain = await corpusOf(env(), who, "alex", { citations: false });

    expect(docsOf(cited.turns)[0].citations).toEqual({ enabled: true });
    expect(docsOf(plain.turns)[0].citations).toBeUndefined();
  });
});

// W86 — the bytes are encoded a chunk at a time, so nothing holds the whole record twice inside a
// 128 MB isolate. That makes the chunk BOUNDARY a correctness question it was not before: base64 is
// three bytes to four characters, so a chunk that is not a multiple of three pads mid-stream and the
// pieces no longer concatenate into the encoding of the original bytes. A PDF is binary, so a
// corrupted one is not a garbled answer — it is a document the model cannot open at all.
describe("the encoded document is the document", () => {
  const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // Deterministic, and every byte value occurs — including the 0x80..0xFF range a latin1 round trip
  // would mangle and an ASCII fixture would never reach.
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + (i >> 8)) & 0xff);

  const CHUNK = 0xc000;

  it.each([
    ["exactly on a chunk boundary", CHUNK * 2],
    ["one byte past one", CHUNK * 2 + 1],
    ["two bytes past one", CHUNK * 2 + 2],
    ["just short of one", CHUNK * 2 - 1],
  ])("round-trips a document ending %s", async (_when, size) => {
    const who = await account("alex");
    const original = bytes(size);
    await store(who, "alex", "labs.pdf", { pages: 1, bytes: original });

    const docs = docsOf((await corpusOf(env(), who, "alex", { citations: true })).turns);

    expect(decode((docs[0].source as { data: string }).data)).toEqual(original);
  });

  // Padding only ever belongs at the very end: a `=` anywhere else is the mid-stream padding a
  // wrongly-sized chunk produces, which decodes without throwing and gives back the wrong bytes.
  it("pads once, at the end, however many chunks the document spans", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1, bytes: bytes(CHUNK * 3 + 1) });

    const data = (docsOf((await corpusOf(env(), who, "alex", { citations: true })).turns)[0].source as { data: string }).data;

    expect(data.indexOf("=")).toBe(data.length - 2);
  });
});

describe("openReportCorpus refuses rather than answers on part of a record", () => {
  it("refuses a namespace the account does not own", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1 });
    const stranger = await account("nobody");

    await expect(corpusOf(env(), stranger, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusDeniedError);
  });

  // Objects with no ownership row belong to nobody until they are claimed deliberately (W76), so a
  // corpus must not read them either — "whoever asks first" is exactly the hole raw-owner.ts closed.
  it("refuses an orphaned namespace", async () => {
    const who = await account("alex");
    await w.bucket.put(`${STORE}/raw/alex/labs.pdf`, PDF("orphan"));

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusDeniedError);
  });

  // The test that pins "fail loudly" as behaviour and not intent: one unmeasured PDF refuses the
  // whole corpus, because a corpus quietly short by one document answers exactly like a full one.
  it("refuses when any PDF has no page count, rather than sending the rest", async () => {
    const who = await account("alex");
    await store(who, "alex", "measured.pdf", { pages: 4 });
    await store(who, "alex", "unmeasured.pdf");

    const err = await corpusOf(env(), who, "alex", { citations: true }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CorpusUnmeasuredError);
    expect((err as CorpusUnmeasuredError).files).toEqual(["unmeasured.pdf"]);
  });

  it("refuses when a recorded document is gone from storage", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1 });
    await w.bucket.delete(`${STORE}/raw/alex/labs.pdf`);

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusMissingError);
  });

  it("names the page ceiling it could not meet", async () => {
    const who = await account("alex");
    await store(who, "alex", "a.pdf", { pages: 180 });
    await store(who, "alex", "b.pdf", { pages: 132 });

    const err = await corpusOf(env(), who, "alex", { citations: true, maxPages: 250 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CorpusTooLargeError);
    expect(err).toMatchObject({ limit: "pages", actual: 312, max: 250 });
  });

  it("honours a smaller ceiling, for a deployment pointing a feature at a smaller model", async () => {
    const who = await account("alex");
    await store(who, "alex", "a.pdf", { pages: 120 });

    await expect(corpusOf(env(), who, "alex", { citations: true, maxPages: 100 })).rejects.toMatchObject({ max: 100 });
    await expect(corpusOf(env(), who, "alex", { citations: true, maxPages: 250 })).resolves.toMatchObject({ docCount: 1 });
  });

  it("names the document ceiling it could not meet", async () => {
    const who = await account("alex");
    for (let i = 0; i <= MAX_CORPUS_DOCS; i += 1) {
      await recordRawObject(w.db, `${STORE}/raw/alex/r${String(i).padStart(3, "0")}.pdf`, who, { pages: 1 });
    }

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toMatchObject({
      limit: "documents",
      actual: MAX_CORPUS_DOCS + 1,
      max: MAX_CORPUS_DOCS,
    });
  });

  it("names the byte ceiling it could not meet", async () => {
    const who = await account("alex");
    await store(who, "alex", "huge.pdf", { pages: 1, bytes: new Uint8Array(MAX_CORPUS_BYTES + 1) });

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toMatchObject({ limit: "bytes", max: MAX_CORPUS_BYTES });
  });

  // A record too big to send should cost one query, not 20 MB of reads and a rejected request.
  it("checks the ceiling before reading a single byte from R2", async () => {
    const who = await account("alex");
    await store(who, "alex", "a.pdf", { pages: 400 });
    const unreadable = { ...env(), VAULT: { list: w.bucket.list.bind(w.bucket), get: () => Promise.reject(new Error("read R2")) } } as unknown as CorpusEnv;

    await expect(corpusOf(unreadable, who, "alex", { citations: true, maxPages: 250 })).rejects.toBeInstanceOf(CorpusTooLargeError);
  });
});

// The 128 MB memory ceiling is per ISOLATE, shared by every request it is running, so two records
// assembled at once is how this Function dies — and a killed isolate takes every unrelated request
// in flight with it, answering a 5xx no handler wrote. These pin the admission gate that prevents it.
describe("an instance assembles only as much as it can hold", () => {
  /** A vault that blocks in `get`, so a second call can be made while the first still holds its budget. */
  function heldVault() {
    let open!: () => void;
    let reading!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    const reached = new Promise<void>((r) => (reading = r));
    const VAULT = {
      get: async (key: string) => {
        reading();
        await opened;
        return w.bucket.get(key);
      },
    };
    return { open, reached, env: { ...env(), VAULT } as unknown as CorpusEnv };
  }

  // THE WINDOW, not the counter, is what makes this gate real. Assembly ending is not the peak: the
  // base64 stays live for the whole upstream call and the SDK serialises a second copy of it, so a
  // reservation released when `readDocuments` returned read 0 during the seconds the isolate held the
  // most — and two requests whose assemblies merely did not overlap killed it between them.
  it("holds the record's bytes until the scope is released, not until the assembly ends", async () => {
    const who = await account("alex");
    await storeUnmeasured(who, "alex", "labs.pdf", 1);

    const first = await openReportCorpus(env(), who, "alex", { citations: true });
    expect(first.corpus.docCount).toBe(1);

    await expect(openReportCorpus(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusBusyError);

    first.release();
    await expect(corpusOf(env(), who, "alex", { citations: true })).resolves.toMatchObject({ docCount: 1 });
  });

  it("refuses the assembly it has no room for, and still finishes the one already running", async () => {
    const who = await account("alex");
    await storeUnmeasured(who, "alex", "labs.pdf", 1);
    const held = heldVault();

    const first = openReportCorpus(held.env, who, "alex", { citations: true });
    await held.reached;

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusBusyError);

    held.open();
    const opened = await first;
    expect(opened.corpus).toMatchObject({ docCount: 1 });
    opened.release();
  });

  // A reservation that survives its own failure is worse than no reservation: the instance refuses
  // work forever while holding nothing, and nobody is left holding a release to call.
  it("gives the budget back when an assembly throws", async () => {
    const who = await account("alex");
    await recordRawObject(w.db, `${STORE}/raw/gone/labs.pdf`, who, { pages: 1 });
    await storeUnmeasured(who, "alex", "labs.pdf", 1);

    await expect(corpusOf(env(), who, "gone", { citations: true })).rejects.toBeInstanceOf(CorpusMissingError);

    await expect(corpusOf(env(), who, "alex", { citations: true })).resolves.toMatchObject({ docCount: 1 });
  });

  // Measured rows reserve what they actually weigh, so ordinary records still overlap freely.
  it("runs two measured records at once when both really fit", async () => {
    const who = await account("alex");
    await store(who, "alex", "labs.pdf", { pages: 1 });
    await store(who, "sam", "labs.pdf", { pages: 1 });
    const held = heldVault();

    const both = Promise.all([
      openReportCorpus(held.env, who, "alex", { citations: true }),
      openReportCorpus(held.env, who, "sam", { citations: true }),
    ]);
    await held.reached;
    held.open();

    const opened = await both;
    expect(opened.map((o) => o.corpus.docCount)).toEqual([1, 1]);
    opened.forEach((o) => o.release());
  });

  // The reservation is capped at MAX_CORPUS_BYTES so a record nobody can send fails as "too large",
  // which is final, rather than as "busy", which invites a retry that will never succeed.
  it("calls a record too big to send too large, never busy", async () => {
    const who = await account("alex");
    await store(who, "alex", "huge.pdf", { pages: 1, bytes: new Uint8Array(MAX_CORPUS_BYTES + 1) });

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusTooLargeError);
  });

  it("admits any number of requests in sequence", async () => {
    const who = await account("alex");
    await storeUnmeasured(who, "alex", "labs.pdf", 1);

    for (let i = 0; i < 4; i += 1) {
      await expect(corpusOf(env(), who, "alex", { citations: true })).resolves.toMatchObject({ docCount: 1 });
    }
  });
});

describe("a client with nothing stored", () => {
  // A patient mid-first-import has an empty namespace and must still be able to ask a question; an
  // empty corpus leaves the request exactly as it was before this feature existed.
  it("is an empty corpus, not a refusal", async () => {
    const who = await account("alex");

    const corpus = await corpusOf(env(), who, "alex", { citations: true });

    expect(corpus).toEqual({ turns: [], docCount: 0, pageCount: 0, byteCount: 0 });
  });

  it("is an empty corpus when the namespace holds only non-PDFs", async () => {
    const who = await account("alex");
    await store(who, "alex", "readings.xlsx");

    expect((await corpusOf(env(), who, "alex", { citations: true })).turns).toEqual([]);
  });
});

// The store is mid-migration for as long as the sweep runs, so every property above has to hold on
// a namespace whose documents are AES-GCM ciphertext under a key that only arrives with the request.
describe("openReportCorpus on a sealed store", () => {
  const newKey = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

  /** The same helper as `store`, with the bytes sealed the way the browser seals an upload. */
  async function storeSealed(owner: string, slug: string, file: string, key: string, pages = 1) {
    return store(owner, slug, file, { pages, bytes: await sealRaw(PDF(file), key) });
  }

  // The whole cost argument for the corpus: decryption is deterministic, so encrypting the store
  // does not move the cache breakpoint. A prefix that differed by one byte would turn every
  // patient's cache read into a full write.
  it("builds the prefix a plaintext store builds, byte for byte", async () => {
    const plain = await account("alex");
    await store(plain, "alex", "labs.pdf", { pages: 1 });
    const key = newKey();
    const sealed = await account("sam");
    await storeSealed(sealed, "sam", "labs.pdf", key);

    const a = await corpusOf(env(), plain, "alex", { citations: true });
    const b = await corpusOf(env(), sealed, "sam", { citations: true, rawKeys: { "labs.pdf": key } });

    expect(JSON.stringify(b.turns)).toBe(JSON.stringify(a.turns));
  });

  // The envelope's 48 bytes are storage overhead, not something the model is sent, so the ceiling
  // has to count what was read rather than what was stored.
  it("budgets on the plaintext it sends, not on the envelope it read", async () => {
    const who = await account("alex");
    const key = newKey();
    await storeSealed(who, "alex", "labs.pdf", key);

    const corpus = await corpusOf(env(), who, "alex", { citations: true, rawKeys: { "labs.pdf": key } });

    expect(corpus.byteCount).toBe(PDF("labs.pdf").length);
  });

  it("refuses a sealed document the request carried no key for", async () => {
    const who = await account("alex");
    await storeSealed(who, "alex", "labs.pdf", newKey());

    await expect(corpusOf(env(), who, "alex", { citations: true })).rejects.toBeInstanceOf(CorpusKeyError);
  });

  it("refuses a key that does not open the document rather than sending garbage", async () => {
    const who = await account("alex");
    await storeSealed(who, "alex", "labs.pdf", newKey());

    await expect(
      corpusOf(env(), who, "alex", { citations: true, rawKeys: { "labs.pdf": newKey() } }),
    ).rejects.toBeInstanceOf(CorpusKeyError);
  });

  // The browser heals the whole record in one pass, so a refusal naming one file at a time would
  // take one round trip per document to get there.
  it("names every document it could not open, not the first", async () => {
    const who = await account("alex");
    const key = newKey();
    await storeSealed(who, "alex", "labs.pdf", newKey());
    await storeSealed(who, "alex", "scan.pdf", key);
    await storeSealed(who, "alex", "xray.pdf", newKey());

    await expect(
      corpusOf(env(), who, "alex", { citations: true, rawKeys: { "scan.pdf": key } }),
    ).rejects.toMatchObject({ files: ["labs.pdf", "xray.pdf"] });
  });

  // THE PROPERTY THAT MUST NOT BE LOST: the key map decrypts, it never authorizes. Holding a valid
  // content key for someone else's document buys nothing — `rawAccessFor` still decides.
  it("refuses another account's namespace to a caller holding a valid key for it", async () => {
    const who = await account("alex");
    const key = newKey();
    await storeSealed(who, "alex", "labs.pdf", key);
    const stranger = await account("nobody");

    await expect(
      corpusOf(env(), stranger, "alex", { citations: true, rawKeys: { "labs.pdf": key } }),
    ).rejects.toBeInstanceOf(CorpusDeniedError);
  });
});
