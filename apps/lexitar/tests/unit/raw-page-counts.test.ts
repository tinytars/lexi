// Real D1: the page count is a number the corpus ceiling is checked against, and a fake that agrees
// with whatever the route does would not catch a count being lowered — which is the whole guard.
import { describe, it, expect } from "vitest";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject, listRawPdfsUnder } from "../../functions/_lib/identity-audit";
import { onRequestGet as rawGet, onRequestPut as rawPut } from "../../functions/api/raw/[[path]]";
import { onRequestPost as rawMeasure } from "../../functions/api/raw/measure";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });
const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as any;

/** An account owning namespace `slug` by virtue of having written the first object into it. */
async function owner(slug: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: slug, email: `${slug}@example.com` });
  return id;
}

const put = async (who: string, slug: string, file: string, query = "") =>
  rawPut({
    request: new Request(`http://x/api/raw/${slug}/${file}${query}`, { method: "PUT", headers: { cookie: await cookieFor(who) }, body: "%PDF-" }),
    env: env(),
    params: { path: [slug, file] },
  } as any);

const pagesOf = async (slug: string, file: string) =>
  (await listRawPdfsUnder(w.db, `${STORE}/raw/${slug}/`)).find((r) => r.r2_key.endsWith(file))?.pages ?? null;

describe("PUT /api/raw records the browser's page count", () => {
  it("stores ?pages= against the uploaded PDF", async () => {
    const who = await owner("alex");
    expect((await put(who, "alex", "report.pdf", "?pages=8")).status).toBe(204);
    expect(await pagesOf("alex", "report.pdf")).toBe(8);
  });

  it("stores no count when ?pages= is absent, which is what the backfill then finds", async () => {
    const who = await owner("alex");
    expect((await put(who, "alex", "report.pdf")).status).toBe(204);
    expect(await pagesOf("alex", "report.pdf")).toBeNull();
  });

  it("400s on a page count that is not a usable integer, rather than storing a wrong one", async () => {
    const who = await owner("alex");
    for (const q of ["?pages=0", "?pages=-1", "?pages=2.5", "?pages=abc", "?pages=100001"]) {
      expect((await put(who, "alex", "report.pdf", q)).status).toBe(400);
    }
  });

  it("stores a count past the attach-time page cap, which a report import can legitimately exceed", async () => {
    const who = await owner("alex");
    expect((await put(who, "alex", "long-report.pdf", "?pages=140")).status).toBe(204);
    expect(await pagesOf("alex", "long-report.pdf")).toBe(140);
  });

  it("400s on ?pages= for a non-PDF, which has no page count to record", async () => {
    const who = await owner("alex");
    expect((await put(who, "alex", "labs.xlsx", "?pages=3")).status).toBe(400);
  });

  it("never lowers a recorded count", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf", "?pages=40");
    await put(who, "alex", "report.pdf", "?pages=1");
    expect(await pagesOf("alex", "report.pdf")).toBe(40);
  });

  it("fills a count that was missing, so a re-upload heals an unmeasured row", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");
    await put(who, "alex", "report.pdf", "?pages=12");
    expect(await pagesOf("alex", "report.pdf")).toBe(12);
  });
});

describe("GET /api/raw/{id}?unmeasured=1", () => {
  it("names only the PDFs with no page count", async () => {
    const who = await owner("alex");
    await put(who, "alex", "measured.pdf", "?pages=3");
    await put(who, "alex", "unmeasured.pdf");
    await recordRawObject(w.db, `${STORE}/raw/alex/labs.xlsx`, who);

    const res = await rawGet({
      request: new Request(`http://x/api/raw/alex?unmeasured=1`, { headers: { cookie: await cookieFor(who) } }),
      env: env(),
      params: { path: ["alex"] },
    } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: ["unmeasured.pdf"] });
  });

  it("still 400s on a missing file segment without the flag", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf", "?pages=3");
    const res = await rawGet({
      request: new Request(`http://x/api/raw/alex`, { headers: { cookie: await cookieFor(who) } }),
      env: env(),
      params: { path: ["alex"] },
    } as any);
    expect(res.status).toBe(400);
  });

  it("404s for an account that does not own the namespace, like every other read", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");
    const stranger = await owner("nobody");
    const res = await rawGet({
      request: new Request(`http://x/api/raw/alex?unmeasured=1`, { headers: { cookie: await cookieFor(stranger) } }),
      env: env(),
      params: { path: ["alex"] },
    } as any);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/raw/measure", () => {
  const measure = async (who: string, body: unknown) =>
    rawMeasure({
      request: new Request("http://x/api/raw/measure", {
        method: "POST",
        headers: { cookie: await cookieFor(who), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env: env(),
    } as any);

  it("records a count without the caller re-uploading the bytes", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");

    const res = await measure(who, { clientId: "alex", counts: [{ file: "report.pdf", pages: 9 }] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ measured: 1, remaining: 0 });
    expect(await pagesOf("alex", "report.pdf")).toBe(9);
  });

  it("reports what is still unmeasured, so the browser knows when to stop", async () => {
    const who = await owner("alex");
    await put(who, "alex", "one.pdf");
    await put(who, "alex", "two.pdf");

    const res = await measure(who, { clientId: "alex", counts: [{ file: "one.pdf", pages: 4 }] });

    expect(await res.json()).toEqual({ measured: 1, remaining: 1 });
  });

  it("cannot change a count that is already recorded", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf", "?pages=40");

    const res = await measure(who, { clientId: "alex", counts: [{ file: "report.pdf", pages: 1 }] });

    expect(await res.json()).toEqual({ measured: 0, remaining: 0 });
    expect(await pagesOf("alex", "report.pdf")).toBe(40);
  });

  it("writes no ownership row for a key that has none", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");

    await measure(who, { clientId: "alex", counts: [{ file: "ghost.pdf", pages: 5 }] });

    expect((await listRawPdfsUnder(w.db, `${STORE}/raw/alex/`)).map((r) => r.r2_key)).toEqual([`${STORE}/raw/alex/report.pdf`]);
  });

  it("400s on a count that is not a usable page number, or on a non-PDF", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");
    for (const counts of [[{ file: "report.pdf", pages: 100001 }], [{ file: "report.pdf", pages: 0 }], [{ file: "labs.xlsx", pages: 3 }]]) {
      expect((await measure(who, { clientId: "alex", counts })).status).toBe(400);
    }
  });

  it("400s on a file name that tries to leave the namespace", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");
    const res = await measure(who, { clientId: "alex", counts: [{ file: "../bob/report.pdf", pages: 5 }] });
    expect(res.status).toBe(400);
  });

  it("404s for an account that does not own the namespace", async () => {
    const who = await owner("alex");
    await put(who, "alex", "report.pdf");
    const stranger = await owner("nobody");
    const res = await measure(stranger, { clientId: "alex", counts: [{ file: "report.pdf", pages: 5 }] });
    expect(res.status).toBe(404);
    expect(await pagesOf("alex", "report.pdf")).toBeNull();
  });
});
