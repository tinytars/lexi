import { describe, it, expect, vi, beforeEach } from "vitest";
import { MARKER_GROUPS_MODEL } from "../../src/lib/marker-groups-config";

// Mock the SDK so the Function's guard + hash short-circuit + generation are exercised with no
// billable call. Like refresh-range, this Function calls `.create` directly (not `.stream`).
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { onRequestPost } from "../../functions/api/refresh-marker-groups";
import { markerGroupsHashOf } from "@pablotech/akesi-pil/marker-groups-prompt";
import { fakeSessionDb } from "./_session-db";

const ENV = { PROVIDER_TOKEN: "provtok", ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), STORE_PREFIX: "dev" };

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
      body: opts.body ?? JSON.stringify({ client: CLIENT }),
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
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: noFinding }) });
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
      generatedBy: { mode: "prod", model: MARKER_GROUPS_MODEL },
    };
    const client = { ...CLIENT, markerGroups: cachedGrouping };
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(lastLine(await bodyText(res)))).toEqual(cachedGrouping);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("regenerates when the stored hash is stale (marker set changed)", async () => {
    const staleGrouping = {
      groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }],
      markerGroupsHash: markerGroupsHashOf(["ApoB"], SYSTEMS), // missing Glucose → stale
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod", model: MARKER_GROUPS_MODEL },
    };
    const client = { ...CLIENT, markerGroups: staleGrouping };
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client }) });
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
    expect(grouping.generatedBy).toEqual({ mode: "prod", model: MARKER_GROUPS_MODEL });

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(MARKER_GROUPS_MODEL);
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
