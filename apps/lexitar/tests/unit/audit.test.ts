import { describe, it, expect, vi, afterEach } from "vitest";
import { auditor, type AuditEntry } from "../../functions/_lib/audit";

// The only fields the R2 audit object may ever carry — the PHI-free invariant, asserted structurally.
const ALLOWED_KEYS = ["at", "route", "requestId", "status", "event", "attempt", "chars", "usage", "errorCode", "reasonCategory", "id", "bytes", "latencyMs"];

function makeBucket() {
  const store = new Map<string, string>();
  return { store, put: async (k: string, v: string) => { store.set(k, v); return { etag: k }; } };
}

const ENV = { STORE_PREFIX: "dev" };

afterEach(() => vi.restoreAllMocks());

describe("auditor — R2 persistence (W39 Phase 3)", () => {
  it("writes one dated, store-prefixed object per event with a per-request seq", async () => {
    const bucket = makeBucket();
    const audit = auditor(bucket, ENV, "/api/refresh-finding", "ray9-SJC");
    await audit({ event: "accepted", status: 200, attempt: 1 });
    await audit({ event: "stream-done", status: 200, attempt: 1, usage: { input: 10, output: 20 } });

    const keys = [...bucket.store.keys()].sort();
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^dev\/logs\/refresh-finding\/\d{4}-\d{2}-\d{2}\/ray9-SJC-\d\.json$/);
    // seq increments so two events in one request never collide on the same key
    expect(keys[0]).toContain("ray9-SJC-0.json");
    expect(keys[1]).toContain("ray9-SJC-1.json");
  });

  it("persists the outcome/cost fields verbatim and stamps `at`", async () => {
    const bucket = makeBucket();
    const audit = auditor(bucket, ENV, "/api/refresh-finding", "ray1");
    await audit({ event: "stream-done", status: 200, attempt: 2, chars: 4096, usage: { input: 5, output: 9 } });
    const obj = JSON.parse([...bucket.store.values()][0]) as AuditEntry & { at: string };
    expect(obj).toMatchObject({
      route: "/api/refresh-finding",
      requestId: "ray1",
      event: "stream-done",
      attempt: 2,
      chars: 4096,
      usage: { input: 5, output: 9 },
    });
    expect(obj.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("PHI-free: a written object only ever carries allowlisted, non-content fields", async () => {
    const bucket = makeBucket();
    const audit = auditor(bucket, ENV, "/api/refresh-finding", "ray2");
    await audit({ event: "validation-fail", status: 204, attempt: 1, reasonCategory: "validation" });
    const obj = JSON.parse([...bucket.store.values()][0]);
    for (const k of Object.keys(obj)) expect(ALLOWED_KEYS).toContain(k);
  });

  it("also console.logs every event (existing dashboard/tail path)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const audit = auditor(makeBucket(), ENV, "/api/refresh-finding", "ray3");
    await audit({ event: "accepted", status: 200 });
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({ route: "/api/refresh-finding", event: "accepted" });
  });

  it("degrades to console-only (no throw) when no R2 bucket is bound", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const audit = auditor(undefined, ENV, "/api/refresh-finding", "ray4");
    await expect(audit({ event: "accepted", status: 200 })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("a failing R2 put never breaks the request path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bucket = { put: async () => { throw new Error("R2 down"); } };
    const audit = auditor(bucket, ENV, "/api/refresh-finding", "ray5");
    await expect(audit({ event: "accepted", status: 200 })).resolves.toBeUndefined();
  });
});
