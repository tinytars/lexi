import { describe, it, expect } from "vitest";
import { onRequestGet as accessEvents } from "../../functions/api/account/access-events";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { insertAccessEvent } from "../../functions/_lib/identity-audit";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

// Patient-visible read of phi_access_events: newest first, capped, scoped to the caller's own subject.
const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET }) as any;
const getEvents = (cookie?: string) => {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return accessEvents({ request: new Request("http://x/api/account/access-events", { headers }), env: makeEnv() });
};

async function mkAccount(displayName: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName });
  return id;
}

describe("GET /api/account/access-events", () => {
  it("401s unauthenticated", async () => {
    expect((await getEvents()).status).toBe(401);
  });

  it("returns the caller's own events newest first", async () => {
    const subject = await mkAccount("Subject");
    for (const action of ["org_recovery_minted", "org_key_decrypt", "org_recovery_revoked"]) {
      await insertAccessEvent(w.db, { actorAccountId: subject, subjectAccountId: subject, action });
    }

    const res = await getEvents(await cookieFor(subject));
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: { action: string }[] };
    expect(events.map((e) => e.action)).toEqual(["org_recovery_revoked", "org_key_decrypt", "org_recovery_minted"]);
  });

  it("never returns another subject's events", async () => {
    const a = await mkAccount("A");
    const b = await mkAccount("B");
    await insertAccessEvent(w.db, { actorAccountId: a, subjectAccountId: a, action: "org_recovery_minted" });
    await insertAccessEvent(w.db, { actorAccountId: b, subjectAccountId: b, action: "org_recovery_minted" });

    const res = await getEvents(await cookieFor(a));
    const { events } = (await res.json()) as { events: { subjectAccountId: string }[] };
    expect(events).toHaveLength(1);
    expect(events[0].subjectAccountId).toBe(a);
  });

  it("caps at 200 events", async () => {
    const subject = await mkAccount("Heavy");
    for (let i = 0; i < 205; i++) {
      await insertAccessEvent(w.db, { actorAccountId: subject, subjectAccountId: subject, action: `event-${i}` });
    }

    const res = await getEvents(await cookieFor(subject));
    const { events } = (await res.json()) as { events: { action: string }[] };
    expect(events).toHaveLength(200);
    // newest first: the last 200 inserted (event-5..event-204), most recent (event-204) leading.
    expect(events[0].action).toBe("event-204");
    expect(events[199].action).toBe("event-5");
  });
});
