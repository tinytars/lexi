import { describe, it, expect, vi, beforeEach } from "vitest";

// Same shape as extract-function.test.ts: the SDK is stubbed so the Function's own behaviour —
// session gate, cache, the no-model text path, the 422-vs-transport split — is exercised with no
// billable call, and "did it call the model at all?" becomes an assertion.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { onRequestPost, onRequestGet } from "../../functions/api/document-extract";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";
import type { StoredObject } from "../../functions/_lib/object-bucket";
import { storedObject } from "../../server/fs-bucket";

// W73 — the routes now resolve who owns a client namespace before touching R2. These tests are about
// content types, etags and path handling, so they seed "acct-1 owns the fixture namespaces" and leave
// the ownership MATRIX (owner vs provider vs stranger, live vs revoked) to raw-authorization.test.ts,
// which settles it against a real D1.
function ownedDb() {
  const db = fakeSessionDb();
  // Both store prefixes, because these fixtures do not agree on one ("dev" here, "test" there) and the
  // ownership key is store-scoped.
  for (const store of ["dev", "test"]) {
    for (const id of ["alex", "blair", "acct-1"]) {
      db.own(`${store}/raw/${id}/%`, "acct-1");
      db.own(`${store}/text/${id}/%`, "acct-1");
      db.own(`${store}/chat-${id}.enc`, "acct-1");
    }
  }
  return db;
}


const READING = {
  documentKind: "Radiology report",
  isMedicalReport: true,
  notReportReason: "",
  text: "IMPRESSION: mid-LAD calcified plaque.",
};

function makeEnv(objects: Record<string, Uint8Array | string> = {}) {
  const store = new Map<string, Uint8Array | string>(Object.entries(objects));
  return {
    SESSION_SECRET: "test-secret",
    DB: ownedDb(),
    ANTHROPIC_API_KEY: "k",
    STORE_PREFIX: "test",
    VAULT: {
      async get(key: string): Promise<StoredObject | null> {
        const v = store.get(key);
        if (v === undefined) return null;
        return storedObject(typeof v === "string" ? new TextEncoder().encode(v) : v);
      },
      async put(key: string, value: string | Uint8Array) {
        store.set(key, value);
        return { etag: key };
      },
    },
    _store: store,
  };
}

async function call(
  env: ReturnType<typeof makeEnv>,
  opts: { auth?: "valid" | "bogus"; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth === "valid") headers.cookie = `hd_session=${await signSession(env, "acct-1")}`;
  else if (opts.auth === "bogus") headers.cookie = "hd_session=bogus";
  return onRequestPost({
    request: new Request("http://local/api/document-extract", {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? { id: "alex", key: "ab12cd34-report.pdf", mediaType: "application/pdf" }),
    }),
    env,
  });
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(READING) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
});

describe("/api/document-extract guards", () => {
  it("401s with no / bogus session and never calls the model", async () => {
    const env = makeEnv();
    expect((await call(env)).status).toBe(401);
    expect((await call(env, { auth: "bogus" })).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s on a path that could escape the id/key namespace", async () => {
    const env = makeEnv();
    const res = await call(env, { auth: "valid", body: { id: "alex", key: "../../etc/passwd" } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("bad_path");
    expect(create).not.toHaveBeenCalled();
  });

  it("415s a file type that is not readable as prose — a spreadsheet is a marker import", async () => {
    const env = makeEnv();
    const res = await call(env, { auth: "valid", body: { id: "alex", key: "ab12-labs.xlsx" } });
    expect(res.status).toBe(415);
    expect((await res.json()).errorCode).toBe("unsupported_document");
    expect(create).not.toHaveBeenCalled();
  });

  it("404s when the attachment was never uploaded", async () => {
    const env = makeEnv();
    const res = await call(env, { auth: "valid" });
    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("/api/document-extract reading", () => {
  it("reads a PDF once and stores the text as a sidecar", async () => {
    const env = makeEnv({ "test/raw/alex/ab12cd34-report.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    const res = await call(env, { auth: "valid" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe(READING.text);
    expect(body.chars).toBe(READING.text.length);
    expect(body.cached).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(env._store.has("test/text/alex/ab12cd34-report.pdf.json")).toBe(true);
  });

  it("sends the PDF as a native document block, not as text", async () => {
    const env = makeEnv({ "test/raw/alex/ab12cd34-report.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    await call(env, { auth: "valid" });
    const content = create.mock.calls[0][0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("document");
    expect(content[0].source.media_type).toBe("application/pdf");
  });

  it("serves a second request for the same content key from the sidecar, with NO model call", async () => {
    const env = makeEnv({ "test/raw/alex/ab12cd34-report.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    await call(env, { auth: "valid" });
    create.mockClear();
    const res = await call(env, { auth: "valid" });
    expect(res.status).toBe(200);
    expect((await res.json()).cached).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("reads a .txt attachment with no model call at all", async () => {
    const env = makeEnv({ "test/raw/alex/ab12-notes.txt": "protocol: 2.5mg weekly" });
    const res = await call(env, { auth: "valid", body: { id: "alex", key: "ab12-notes.txt", mediaType: "text/plain" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("protocol: 2.5mg weekly");
    expect(body.isMedicalReport).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("422s an unusable model response rather than mapping it to a transport error", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ...READING, text: "" }) }],
      stop_reason: "end_turn",
      usage: {},
    });
    const env = makeEnv({ "test/raw/alex/ab12cd34-report.pdf": new Uint8Array([0x25]) });
    const res = await call(env, { auth: "valid" });
    expect(res.status).toBe(422);
    expect((await res.json()).errorCode).toBe("invalid_extraction");
  });

  it("maps a credit exhaustion to 402, not to 422", async () => {
    // The shape classifyAnthropicError actually reads: status 400 + a "credit balance" message.
    create.mockRejectedValueOnce({ status: 400, type: "invalid_request_error", message: "Your credit balance is too low" });
    const env = makeEnv({ "test/raw/alex/ab12cd34-report.pdf": new Uint8Array([0x25]) });
    const res = await call(env, { auth: "valid" });
    expect(res.status).toBe(402);
    expect((await res.json()).errorCode).toBe("insufficient_credit");
  });
});

describe("GET /api/document-extract", () => {
  async function get(env: ReturnType<typeof makeEnv>, query: string, auth = true) {
    const headers: Record<string, string> = {};
    if (auth) headers.cookie = `hd_session=${await signSession(env, "acct-1")}`;
    return onRequestGet({ request: new Request(`http://local/api/document-extract?${query}`, { headers }), env });
  }

  it("returns the sidecar without ever calling the model", async () => {
    const env = makeEnv({ "test/text/alex/ab12-x.pdf.json": JSON.stringify({ ...READING, at: "now", chars: 3 }) });
    const res = await get(env, "id=alex&key=ab12-x.pdf");
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe(READING.text);
    expect(create).not.toHaveBeenCalled();
  });

  it("404s a document that has never been extracted, instead of extracting it as a side effect", async () => {
    const env = makeEnv({ "test/raw/alex/ab12-x.pdf": new Uint8Array([0x25]) });
    expect((await get(env, "id=alex&key=ab12-x.pdf")).status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    const env = makeEnv();
    expect((await get(env, "id=alex&key=x.pdf", false)).status).toBe(401);
  });
});
