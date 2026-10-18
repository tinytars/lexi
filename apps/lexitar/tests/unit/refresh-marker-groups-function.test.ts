import { describe, it, expect, vi, beforeEach } from "vitest";
import { modelId } from "../../src/lib/model-config";

// Mock the SDK so the Function's guard + hash short-circuit + generation are exercised with no
// billable call. Like refresh-range, this Function calls `.create` directly (not `.stream`).
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { onRequestPost } from "../../functions/api/refresh-marker-groups";
import { markerGroupsHashOf } from "@pablotech/akesi/marker-groups-prompt";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { CORPUS_ACK } from "../../functions/_lib/inference/corpus";
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd } from "../support/miniflare";

// REPORTS is unset here — a deployment that never turned the corpus on — so a VAULT that throws on
// contact is the assertion that these cases read no reports. The audit trail's own put throws too,
// which auditor() swallows by design: a log write never breaks the request it logs.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { PROVIDER_TOKEN: "provtok", ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), VAULT: NO_STORAGE, STORE_PREFIX: "dev" };

const SYSTEMS = ["Cardiovascular Risk", "Metabolic Health"];
const MARKER_NAMES = ["ApoB", "Glucose"];

const CLIENT = {
  displayName: "P",
  dob: "1980-01-01",
  gender: "male",
  watchlist: [],
  results: [
    { marker: "ApoB", group: "g", source: "Blood", date: "2026-01-01", value: 1, unit: "mg/dL" },
    { marker: "Glucose", group: "g", source: "Blood", date: "2026-01-01", value: 90, unit: "mg/dL" },
  ],
  finding: { disease: [{ group: "Cardiovascular Risk", finding: "f1" }, { group: "Metabolic Health", finding: "f2" }] },
};

const FULL_GROUPING_JSON = {
  groups: [
    { group: "Cardiovascular Risk", markers: ["ApoB"] },
    { group: "Metabolic Health", markers: ["Glucose"] },
  ],
};

function fakeResponse(json: unknown = FULL_GROUPING_JSON, stopReason = "end_turn") {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: stopReason,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

function call(opts: { auth?: string; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  return onRequestPost({
    request: new Request("http://x/api/refresh-marker-groups", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ client: CLIENT, clientId: "alex", accountId: "acct-1" }),
    }),
    env: ENV,
  });
}

const bodyText = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
const lastLine = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)!;

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(fakeResponse());
});

describe("/api/refresh-marker-groups guard", () => {
  it("401s without / with a wrong PROVIDER_TOKEN and never calls the model", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ auth: "Bearer nope" })).status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON and a missing client", async () => {
    expect((await call({ auth: "Bearer provtok", body: "{not json" })).status).toBe(400);
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({}) })).status).toBe(400);
  });

  it("400s when the client has no System Analysis yet", async () => {
    const noFinding = { ...CLIENT, finding: undefined };
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: noFinding, clientId: "alex", accountId: "acct-1" }) });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("/api/refresh-marker-groups hash short-circuit", () => {
  it("returns the existing grouping with zero Anthropic calls when the hash already matches", async () => {
    const cachedGrouping = {
      groups: FULL_GROUPING_JSON.groups,
      markerGroupsHash: markerGroupsHashOf(MARKER_NAMES, SYSTEMS),
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod", model: modelId("markerGroups") },
    };
    const client = { ...CLIENT, markerGroups: cachedGrouping };
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client, clientId: "alex", accountId: "acct-1" }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(lastLine(await bodyText(res)))).toEqual(cachedGrouping);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("regenerates when the stored hash is stale (marker set changed)", async () => {
    const staleGrouping = {
      groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }],
      markerGroupsHash: markerGroupsHashOf(["ApoB"], SYSTEMS), // missing Glucose → stale
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod", model: modelId("markerGroups") },
    };
    const client = { ...CLIENT, markerGroups: staleGrouping };
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client, clientId: "alex", accountId: "acct-1" }) });
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("/api/refresh-marker-groups generation", () => {
  it("200s and streams the complete MarkerGrouping on the final line", async () => {
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const grouping = JSON.parse(lastLine(await bodyText(res)));
    expect(grouping.groups).toEqual(FULL_GROUPING_JSON.groups);
    expect(grouping.markerGroupsHash).toBe(markerGroupsHashOf(MARKER_NAMES, SYSTEMS));
    expect(grouping.generatedBy).toEqual({ mode: "prod", model: modelId("markerGroups") });

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(modelId("markerGroups"));
    expect(args.output_config.format.type).toBe("json_schema");
  });

  it("only calls the model once when the first pass places every marker", async () => {
    await bodyText(await call({ auth: "Bearer provtok" }));
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("runs a completeness re-pass when the first pass leaves a marker unplaced", async () => {
    createMock
      .mockResolvedValueOnce(fakeResponse({ groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }] }))
      .mockResolvedValueOnce(fakeResponse({ groups: [{ group: "Metabolic Health", markers: ["Glucose"] }] }));
    const res = await call({ auth: "Bearer provtok" });
    const grouping = JSON.parse(lastLine(await bodyText(res)));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(grouping.groups.flatMap((g: { markers: string[] }) => g.markers).sort()).toEqual(MARKER_NAMES);
  });

  it("signals a post-header failure in-band via [[REFRESH_ERROR]] (still HTTP 200)", async () => {
    createMock.mockRejectedValue(new Error("overloaded_error"));
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect(await bodyText(res)).toContain("[[REFRESH_ERROR]] overloaded_error");
  });
});

describe("/api/refresh-marker-groups groups in sight of the patient's reports", () => {
  const w = useWorkerd({ r2: true, perTest: true });
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(fakeResponse());
  });

  async function alexWithAReport(): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 report"));
    await recordRawObject(w.db, key, id, { pages: 2, bytes: 15 });
    return id;
  }

  const post = async (headers: Record<string, string>, body: unknown) =>
    onRequestPost({
      request: new Request("http://x/api/refresh-marker-groups", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env: { PROVIDER_TOKEN: "provtok", ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
             DB: w.db, VAULT: w.bucket, STORE_PREFIX: "dev", REPORTS: "always" } as never,
    });

  it("leads every pass with the reports, so the sweep-up pass reads what the first wrote", async () => {
    const who = await alexWithAReport();
    createMock
      .mockResolvedValueOnce(fakeResponse({ groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }] }))
      .mockResolvedValueOnce(fakeResponse({ groups: [{ group: "Metabolic Health", markers: ["Glucose"] }] }));

    const res = await post({ cookie: `hd_session=${await signSession(ENV, who)}` }, { client: CLIENT, clientId: "alex" });
    await bodyText(res);

    expect(createMock).toHaveBeenCalledTimes(2);
    const prefixOf = (pass: number) => JSON.stringify(createMock.mock.calls[pass][0].messages.slice(0, 2));
    expect(createMock.mock.calls[0][0].messages[0].content[0].type).toBe("document");
    expect(createMock.mock.calls[0][0].messages[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
    expect(prefixOf(1)).toBe(prefixOf(0));
  });

  // The hash short-circuit is hoisted out of the stream precisely so a cached grouping costs no
  // report read; a bucket that is never touched is how that stays true.
  it("reads no reports when the stored hash already matches", async () => {
    const who = await alexWithAReport();
    const cached = {
      groups: FULL_GROUPING_JSON.groups,
      markerGroupsHash: markerGroupsHashOf(MARKER_NAMES, SYSTEMS),
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod", model: modelId("markerGroups") },
    };

    const res = await onRequestPost({
      request: new Request("http://x/api/refresh-marker-groups", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hd_session=${await signSession(ENV, who)}` },
        body: JSON.stringify({ client: { ...CLIENT, markerGroups: cached }, clientId: "alex" }),
      }),
      env: { PROVIDER_TOKEN: "provtok", ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
             DB: w.db, VAULT: NO_STORAGE_READS(w), STORE_PREFIX: "dev", REPORTS: "always" } as never,
    });

    expect(JSON.parse(lastLine(await bodyText(res)))).toEqual(cached);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("404s before the stream on a namespace the session's account does not own", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    const res = await post({ cookie: `hd_session=${await signSession(ENV, stranger)}` }, { client: CLIENT, clientId: "alex" });

    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s when a bearer-only caller names no account", async () => {
    await alexWithAReport();

    const res = await post({ authorization: "Bearer provtok" }, { client: CLIENT, clientId: "alex" });

    expect(res.status).toBe(400);
    expect(JSON.parse(await bodyText(res)).errorCode).toBe("no_account_id");
    expect(createMock).not.toHaveBeenCalled();
  });
});

// The audit trail still has to write, so only the corpus reads are booby-trapped.
function NO_STORAGE_READS(w: { bucket: { put: unknown } }) {
  return {
    put: (w.bucket as { put: (...a: never[]) => unknown }).put.bind(w.bucket),
    get: () => { throw new Error("touched storage"); },
    list: () => { throw new Error("touched storage"); },
  };
}
