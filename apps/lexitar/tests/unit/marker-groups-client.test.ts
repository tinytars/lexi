import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "../../src/lib/types";
import { markerGroupsHashOf } from "@pablotech/akesi/marker-groups-prompt";
import { refreshMarkerGroups } from "../../src/lib/marker-groups-client";

const SYSTEMS = ["Cardiovascular Risk"];
const MARKER_NAMES = ["ApoB"];

const BASE_CLIENT = {
  displayName: "P",
  dob: "1980-01-01",
  gender: "male",
  watchlist: [],
  results: [{ marker: "ApoB", group: "g", source: "Blood", date: "2026-01-01", value: 1, unit: "mg/dL" }],
  finding: { disease: [{ group: "Cardiovascular Risk", finding: "f1" }] },
} as unknown as Client;

function streamResponse(text: string): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("refreshMarkerGroups client-side hash pre-check", () => {
  it("skips the network round-trip entirely when the stored hash already matches", async () => {
    const cached = {
      groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }],
      markerGroupsHash: markerGroupsHashOf(MARKER_NAMES, SYSTEMS),
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod" as const, model: "claude-opus-4-7" },
    };
    const client = { ...BASE_CLIENT, markerGroups: cached };
    const result = await refreshMarkerGroups(client, "alex");
    expect(result).toBe(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still calls the network when force is set, even with a matching hash", async () => {
    const fresh = {
      groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }],
      markerGroupsHash: markerGroupsHashOf(MARKER_NAMES, SYSTEMS),
      generatedAt: "2026-01-02T00:00:00.000Z",
      generatedBy: { mode: "prod" as const, model: "claude-opus-4-7" },
    };
    const cached = { ...fresh, generatedAt: "2026-01-01T00:00:00.000Z" };
    fetchMock.mockResolvedValue(streamResponse(JSON.stringify(fresh)));
    const client = { ...BASE_CLIENT, markerGroups: cached };
    const result = await refreshMarkerGroups(client, "alex", { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(fresh);
  });
});

describe("refreshMarkerGroups network path", () => {
  it("POSTs the client, sends the bearer only when providerToken is set, and parses the final line", async () => {
    const grouping = {
      groups: [{ group: "Cardiovascular Risk", markers: ["ApoB"] }],
      markerGroupsHash: markerGroupsHashOf(MARKER_NAMES, SYSTEMS),
      generatedAt: "2026-01-01T00:00:00.000Z",
      generatedBy: { mode: "prod", model: "claude-opus-4-7" },
    };
    fetchMock.mockResolvedValue(streamResponse(`[[PASS]] 1\n${JSON.stringify(grouping)}`));
    const result = await refreshMarkerGroups(BASE_CLIENT, "alex", { providerToken: "provtok" });
    expect(result).toEqual(grouping);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/refresh-marker-groups");
    expect(JSON.parse(init.body as string).client).toEqual(BASE_CLIENT);
    expect(JSON.parse(init.body as string).clientId).toBe("alex");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer provtok");
  });

  it("omits the Authorization header when no providerToken is given (patient's own session)", async () => {
    fetchMock.mockResolvedValue(streamResponse(JSON.stringify({ groups: [], markerGroupsHash: "x", generatedAt: "t", generatedBy: {} })));
    await refreshMarkerGroups(BASE_CLIENT, "alex");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws on the [[REFRESH_ERROR]] sentinel", async () => {
    fetchMock.mockResolvedValue(streamResponse("[[REFRESH_ERROR]] generation failed"));
    await expect(refreshMarkerGroups(BASE_CLIENT, "alex")).rejects.toThrow("generation failed");
  });

  it("throws with the server's errorCode when the response is non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "no System Analysis yet", errorCode: "no_finding" }), { status: 400 }),
    );
    const err = await refreshMarkerGroups(BASE_CLIENT, "alex").catch((e) => e);
    expect(err.message).toBe("no System Analysis yet");
    expect(err.errorCode).toBe("no_finding");
  });
});
