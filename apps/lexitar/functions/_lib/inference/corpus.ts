// The patient's own reports, as the model sees them: every PDF under `{store}/raw/{clientId}/`,
// original bytes, attached to the front of the request. See CORPUS.md.
//
// WHY THE ORIGINALS AND NOT AN EXTRACTION. A structured extraction answers the questions its schema
// anticipated. A radiologist's aside, a table row nothing models, a footnote — none of them survive
// it, and the model cannot tell that they are missing, so it answers confidently from a partial
// record. Attaching the document itself is the only shape where "ask about anything in any report"
// is true rather than approximately true.
//
// WHY AUTHORISATION LIVES HERE. `rawAccessFor` runs INSIDE this assembler, not in the eight routes
// that call it. A route that forgets the check cannot exist, because there is no way to obtain a
// corpus without passing an accountId through this function.
//
// WHY EVERY FAILURE IS AN ERROR AND NEVER A SHORTER CORPUS. A corpus missing one document produces
// an answer that reads exactly like a complete one. Every branch below that cannot attach everything
// throws, and the routes turn that into a refusal naming the limit.
import type Anthropic from "@anthropic-ai/sdk";
import type { D1Database } from "../identity-types";
import { listRawPdfsUnder } from "../identity-audit";
import { mayRead, rawAccessFor, type NamespaceEnv } from "../raw-owner";
import { storeKey } from "../store";
import type { ObjectBucket } from "../object-bucket";
import { normalizeClientId } from "../../../src/lib/client-id";
import { DEFAULT_MAX_CORPUS_PAGES } from "../../../src/lib/model-config";
import { CORPUS_PREAMBLE, CORPUS_ACK } from "../../../src/lib/corpus-prompt";
import { CorpusDeniedError, CorpusMissingError, CorpusTooLargeError, CorpusUnmeasuredError } from "./corpus-errors";

// Re-exported so the assembler stays the one door a reader looks behind for the prefix, wherever the
// strings themselves have to live.
export { CORPUS_PREAMBLE, CORPUS_ACK };

export interface CorpusEnv extends NamespaceEnv {
  DB: D1Database;
  VAULT: Pick<ObjectBucket, "get" | "list">;
}

/**
 * Transport ceilings, as opposed to the model ceiling.
 *
 * Pages are a property of the MODEL behind a feature — a 200 K-context model holds far fewer than a
 * 1 M one — so that limit is configured per provider in inference.config.json and arrives as
 * `opts.maxPages`. Bytes and document count are properties of the REQUEST and are the same for every
 * provider: 20 MB inflates to ~27.4 MB as base64, under Anthropic's 32 MB request cap.
 */
export const MAX_CORPUS_BYTES = 20 * 1024 * 1024;
export const MAX_CORPUS_DOCS = 100;

export interface Corpus {
  /** The two leading turns, or none at all when the client has no stored PDFs. */
  turns: Anthropic.MessageParam[];
  docCount: number;
  pageCount: number;
  byteCount: number;
}

export const emptyCorpus = (): Corpus => ({ turns: [], docCount: 0, pageCount: 0, byteCount: 0 });

/**
 * Whether this deployment attaches reports at all — `REPORTS` in wrangler.jsonc's `vars`, or the
 * process env on the Node host, exactly like STORE_PREFIX.
 *
 * Unset means "never", so a deployment that has not said yes keeps the behaviour it had before this
 * feature existed: no PHI in a prefix it did not ask for, and no change to its bill. A value that is
 * neither word throws rather than defaulting — a typo silently turning the whole feature off is the
 * failure mode a flag like this always has.
 */
export function reportsAttached(env: { REPORTS?: string }): boolean {
  const v = (env.REPORTS ?? "never").trim();
  if (v !== "always" && v !== "never") throw new Error(`REPORTS must be "always" or "never", not ${JSON.stringify(v)}`);
  return v === "always";
}

// A MULTIPLE OF 3, and that is the whole reason this constant exists rather than the round 0x8000
// this loop used to use: 3 bytes are one base64 quartet, so only a chunk of that shape encodes
// without padding, and only unpadded pieces concatenate into the string a single btoa over the whole
// array would have produced. The bytes are a prompt-cache prefix — a different string is a different
// prefix and pays a full cache write for every patient. It also has to stay under the argument count
// String.fromCharCode(...) accepts, which is what the chunking was originally for.
const BASE64_CHUNK_BYTES = 0xc000;

// W86 — btoa per chunk, rather than building the whole latin1 string and encoding it once. Both
// forms return the same string; this one never holds the input twice. A 15 MB record used to sit in
// the isolate as bytes AND as a 15 MB intermediate AND as 20 MB of base64 at the same moment, and
// the 128 MB ceiling is per ISOLATE, not per request — see the concurrency note in corpus-lane.ts.
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES)));
  }
  return out;
}

/**
 * Assembles one client's reports into the leading turns of a request.
 *
 * `citations` is off for a feature that asks for a JSON schema — `output_config.format` and
 * `citations` are mutually exclusive — and on everywhere else, where a `page_location` cite is what
 * lets an answer point at the page it came from.
 */
export async function reportCorpus(
  env: CorpusEnv,
  accountId: string,
  clientId: string,
  opts: { citations: boolean; maxPages?: number },
): Promise<Corpus> {
  const slug = normalizeClientId(clientId);
  const access = await rawAccessFor(env.DB, env, accountId, slug);
  // `unclaimed` means R2 holds nothing at all under this client — a new patient, mid-first-import.
  // That is an empty corpus, not a refusal: they must still be able to ask a question. Every other
  // non-readable kind, orphans included, is a refusal.
  if (access.kind === "unclaimed") return emptyCorpus();
  if (!mayRead(access)) throw new CorpusDeniedError(slug);

  const prefix = storeKey(env, "raw", slug, "");
  const rows = await listRawPdfsUnder(env.DB, prefix);
  if (rows.length === 0) return emptyCorpus();

  const unmeasured = rows.filter((r) => r.pages === null).map((r) => r.r2_key.slice(prefix.length));
  if (unmeasured.length > 0) throw new CorpusUnmeasuredError(unmeasured);

  // Both ceilings are checked against D1 alone, BEFORE a byte is read from R2: a record that cannot
  // be sent should cost one query, not 20 MB of reads and a rejected request.
  if (rows.length > MAX_CORPUS_DOCS) throw new CorpusTooLargeError("documents", rows.length, MAX_CORPUS_DOCS);
  const pageCount = rows.reduce((n, r) => n + (r.pages ?? 0), 0);
  const maxPages = opts.maxPages ?? DEFAULT_MAX_CORPUS_PAGES;
  if (pageCount > maxPages) throw new CorpusTooLargeError("pages", pageCount, maxPages);

  // Sorted here even though the query already orders by key: these turns are a prompt-cache prefix,
  // and a prefix that reorders between two requests is a different prefix that pays a full write.
  // The two hosts run two different sqlite builds, so their ORDER BY collation is not this module's
  // to assume — one explicit comparator is what makes the bytes stable across both.
  const keys = rows.map((r) => r.r2_key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const docs: Anthropic.DocumentBlockParam[] = [];
  let byteCount = 0;
  for (const key of keys) {
    const object = await env.VAULT.get(key);
    if (!object) throw new CorpusMissingError();
    const bytes = new Uint8Array(await object.arrayBuffer());
    byteCount += bytes.length;
    // The byte ceiling is checked on what was actually read, not on the stored `bytes` column, which
    // a count-only backfill leaves null. Checked inside the loop so an oversized record stops at the
    // document that crosses the line instead of buffering the whole of it first.
    if (byteCount > MAX_CORPUS_BYTES) throw new CorpusTooLargeError("bytes", byteCount, MAX_CORPUS_BYTES);
    docs.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) },
      // The filename and nothing else. A date, an etag or a page count here would be one more byte
      // ahead of the breakpoint that can change without the document changing.
      title: key.slice(prefix.length),
      ...(opts.citations ? { citations: { enabled: true } } : {}),
    });
  }

  // The breakpoint sits on the LAST DOCUMENT, not on the preamble that follows it, so the preamble's
  // wording can be edited without invalidating every patient's cached corpus.
  docs[docs.length - 1] = { ...docs[docs.length - 1], cache_control: { type: "ephemeral" } };

  return {
    // The assistant ack is not decoration: it closes the prefix on a message boundary, which is what
    // stops openai.ts's `userParts` from concatenating corpus text and question text into one
    // OpenAI message — and gives the model a turn that says what the documents are for.
    turns: [
      { role: "user", content: [...docs, { type: "text", text: CORPUS_PREAMBLE }] },
      { role: "assistant", content: CORPUS_ACK },
    ],
    docCount: docs.length,
    pageCount,
    byteCount,
  };
}
