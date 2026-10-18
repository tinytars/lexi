import { describe, it, expect } from "vitest";
import { onRequestGet, onRequestPut } from "../../functions/api/account/persona";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const w = useWorkerd();
const env = () => ({ DB: w.db, SESSION_SECRET }) as any;

async function mkAccount() {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "P", email: `${id}@x.test` });
  return cookieFor(id);
}
const get = async (cookie: string) =>
  onRequestGet({ request: new Request("http://x/api/account/persona", { headers: { cookie } }), env: env() });
const put = async (cookie: string, body: unknown) =>
  onRequestPut({ request: new Request("http://x/api/account/persona", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: typeof body === "string" ? body : JSON.stringify(body) }), env: env() });

describe("/api/account/persona", () => {
  it("reads null for an account that never chose", async () => {
    const res = await get(await mkAccount());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persona: null });
  });

  it("round-trips a PUT through GET", async () => {
    const cookie = await mkAccount();
    expect((await put(cookie, { persona: "cody" })).status).toBe(200);
    expect(await (await get(cookie)).json()).toEqual({ persona: "cody" });
  });

  it("is per account", async () => {
    const a = await mkAccount();
    const b = await mkAccount();
    await put(a, { persona: "cody" });
    await put(b, { persona: "lexi" });
    expect(await (await get(a)).json()).toEqual({ persona: "cody" });
    expect(await (await get(b)).json()).toEqual({ persona: "lexi" });
  });

  it("reads an account saved before the rename as Cody, and stores the new id from an old tab's PUT", async () => {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "P", email: `${id}@x.test` });
    const cookie = await cookieFor(id);
    await w.db.prepare("UPDATE accounts SET persona = 'kodi' WHERE id = ?").bind(id).run();
    expect(await (await get(cookie)).json()).toEqual({ persona: "cody" });
    expect(await (await put(cookie, { persona: "kodi" })).json()).toEqual({ persona: "cody" });
    expect(await w.db.prepare("SELECT persona FROM accounts WHERE id = ?").bind(id).first()).toEqual({ persona: "cody" });
  });

  it("rejects a persona that is not in the registry", async () => {
    const cookie = await mkAccount();
    expect((await put(cookie, { persona: "hal" })).status).toBe(400);
    expect((await put(cookie, "{not json")).status).toBe(400);
    expect(await (await get(cookie)).json()).toEqual({ persona: null });
  });

  it("requires a session", async () => {
    expect((await get("")).status).toBe(401);
    expect((await put("", { persona: "cody" })).status).toBe(401);
  });
});
