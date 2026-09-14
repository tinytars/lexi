import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import { onRequestPost as crmEvent } from "../../functions/api/crm/event";
import { emitLifecycleEvent } from "../../functions/_lib/lifecycle";
import type { LifecycleStage } from "../../functions/_lib/identity-types";
import { createAccount, getAccount } from "../../functions/_lib/identity-accounts";
import { signSession } from "../../functions/_lib/session";

let mf: Miniflare;
let db: any;
const SECRET = "test-secret";

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "test-crm" } });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as import("../../functions/_lib/identity-types").D1Database);
});
afterAll(async () => { await mf.dispose(); });

const makeEnv = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookieFor = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
async function post(actorId: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actorId) headers.cookie = await cookieFor(actorId);
  return crmEvent({ request: new Request("http://x/api/crm/event", { method: "POST", headers, body: JSON.stringify(body) }), env: makeEnv() });
}
async function mkAccount(stage: LifecycleStage) {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "A", lifecycleStage: stage });
  return id;
}

describe("emitLifecycleEvent (the seam)", () => {
  it("advances the stage on a valid transition and records the row", async () => {
    const id = await mkAccount("lead");
    const row = await emitLifecycleEvent(db, id, "signup");
    expect(row).toMatchObject({ event: "signup", stageFrom: "lead", stageTo: "active" });
    expect((await getAccount(db, id))!.lifecycleStage).toBe("active");
  });

  it("records an invalid transition as a no-op (stage unchanged, meta.rejectedTarget)", async () => {
    const id = await mkAccount("active");
    const row = await emitLifecycleEvent(db, id, "waitlist_joined");
    expect(row!.stageTo).toBe("active");
    expect((row!.meta as any).rejectedTarget).toBe("waitlist");
    expect((await getAccount(db, id))!.lifecycleStage).toBe("active");
  });

  it("returns null for an unknown account", async () => {
    expect(await emitLifecycleEvent(db, "nope", "signup")).toBeNull();
  });
});

describe("POST /api/crm/event (stub)", () => {
  it("401s without a session", async () => {
    expect((await post(null, { event: "email_confirmed" })).status).toBe(401);
  });

  it("records a non-billing event for the caller and fires NO outbound fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const id = await mkAccount("lead");
    const res = await post(id, { event: "account_created" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).event).toMatchObject({ event: "account_created", stageTo: "active" });
    expect((await getAccount(db, id))!.lifecycleStage).toBe("active");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a billing-driven event (must come from the payment webhook, not a client)", async () => {
    const id = await mkAccount("active");
    const res = await post(id, { event: "payment_succeeded" });
    expect(res.status).toBe(403);
    expect((await getAccount(db, id))!.lifecycleStage).toBe("active"); // no self-promotion
  });

  it("400s on a missing event", async () => {
    const id = await mkAccount("active");
    expect((await post(id, {})).status).toBe(400);
  });
});
