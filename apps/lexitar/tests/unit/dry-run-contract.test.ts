// W77 — `--dry-run` has ONE meaning across every command that spends money: no Anthropic call, no
// write. Before this it meant that for exactly three of ingest's flags and was silently ignored for
// the rest, so `--refresh-ranges --dry-run` regenerated ranges for real and pushed them to R2.
//
// The assertion is on `fetch`, not on a mocked generateRange, because fetch is the real network
// boundary the Anthropic SDK ends at: everything from the command down to the HTTP call is the
// production code path. Each block therefore comes in a pair — the dry run must reach zero calls,
// and the SAME fixture without the flag must reach a non-zero count. Without that second half the
// test would pass just as happily against a fixture too empty to generate anything, which is the
// vacuous-pass this repo has been bitten by.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// R2 has no fetch to count: vault-sync.ts reaches it by shelling out to `npx wrangler r2 object …`,
// so the child process IS the write boundary and counting spawns is the exact analogue of counting
// HTTP calls above.
const { spawns } = vi.hoisted(() => ({ spawns: [] as string[] }));
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      spawns.push([cmd, ...args].join(" "));
      cb(new Error("child processes blocked in unit tests"));
    },
  };
});
import { refreshFindingFor, refreshRangesFor, refreshMarkerGroupsFor } from "../../scripts/commands/refresh";
import { processPendingFor } from "../../scripts/commands/reconcile";
import { UsageAccumulator } from "../../scripts/inference-cost";
import type { Client } from "../../src/lib/types";

let calls: string[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  spawns.length = 0;
  realFetch = globalThis.fetch;
  // Rejecting rather than resolving keeps a leak loud two ways: the counter goes up, and the
  // command's own error path runs instead of it parsing a fabricated Finding.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("network blocked in unit tests");
  }) as unknown as typeof globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-unit-test-not-a-real-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: ["ApoB"],
    recommended: [],
    factorsHash: "hash-of-the-current-factors",
    results: [
      { marker: "ApoB", value: 92, unit: "mg/dL", date: "2026-01-02" },
      { marker: "Lp(a)", value: 40, unit: "nmol/L", date: "2026-01-02" },
    ],
    factors: { decisions: [], treatments: [] },
    finding: {
      disease: [{ group: "Cardiovascular Risk", finding: "elevated ApoB" }],
      nodeHashes: {},
    },
  } as unknown as Client;
}

const usage = () => new UsageAccumulator();

describe("--dry-run makes no Anthropic call", () => {
  it("refresh-finding: plans instead of regenerating", async () => {
    // force:true so the plan is unambiguously "full" — the branch that bills an Opus core regen.
    await refreshFindingFor(client(), true, "dev", usage(), true);
    expect(calls).toEqual([]);

    await expect(refreshFindingFor(client(), true, "dev", usage(), false)).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refresh-ranges: names the markers instead of generating them", async () => {
    const opts = { refreshMarkers: ["ApoB"], allMarkers: false, force: true, dryRun: true };
    await refreshRangesFor(client(), opts, "dev", usage());
    expect(calls).toEqual([]);

    // refreshRangesFor reports per-marker failures rather than throwing, so the call count is the
    // only signal that the real path went to the network.
    await refreshRangesFor(client(), { ...opts, dryRun: false }, "dev", usage());
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refresh-marker-groups: counts the markers instead of grouping them", async () => {
    await refreshMarkerGroupsFor(client(), true, "dev", usage(), true);
    expect(calls).toEqual([]);

    await expect(refreshMarkerGroupsFor(client(), true, "dev", usage(), false)).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("--dry-run makes no R2 write", () => {
  function withPending(): Client {
    const c = client();
    (c as unknown as { pendingUploads: unknown[] }).pendingUploads = [
      { id: "p1", file: "ab12cd34-labs.pdf", originalName: "labs.pdf", sha256: "ab12cd34" },
    ];
    return c;
  }

  it("process-pending touches neither Anthropic nor R2, and leaves the queue intact", async () => {
    const c = withPending();
    const { provisionalFiles } = await processPendingFor(c, "Pablo", "dev", usage(), true);

    expect(calls).toEqual([]);
    expect(spawns).toEqual([]);
    // ingest.ts and reconcileClient both gate "push the folds back to R2, then delete the browser's
    // provisional keys" on this array being non-empty, so an empty one is load-bearing.
    expect(provisionalFiles).toEqual([]);
    // And the queue is untouched, so a real run afterwards still has the same work to do.
    expect((c as unknown as { pendingUploads: unknown[] }).pendingUploads).toHaveLength(1);

    // The control: the same fixture without the flag goes straight at R2 for the raw.
    await processPendingFor(withPending(), "Pablo", "dev", usage(), false);
    expect(spawns.join(" ")).toContain("wrangler");
  });
});
