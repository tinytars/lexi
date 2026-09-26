// Real D1, because the property under test is WHICH rows the listing draws from: the browser's
// sealing sweep diffs this against its key ring, and the corpus reads these same rows. A fake that
// answered from the bucket would agree with the route while disagreeing with the corpus.
import { describe, it, expect } from "vitest";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { onRequestGet as rawGet } from "../../functions/api/raw/[[path]]";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });
const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as any;

async function owner(slug: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: slug, email: `${slug}@example.com` });
  return id;
}

const list = async (who: string, slug: string) =>
  rawGet({
    request: new Request(`http://x/api/raw/${slug}?files=1`, { headers: { cookie: await cookieFor(who) } }),
    env: env(),
    params: { path: [slug] },
  } as any);

describe("GET /api/raw/{id}?files=1", () => {
  // Not only the PDFs, unlike ?unmeasured=1: an XLSX left in plaintext is the same exposure, and an
  // object the record no longer points at is still one the corpus reads.
  it("names every recorded object under the namespace, whatever its type", async () => {
    const who = await owner("alex");
    await recordRawObject(w.db, `${STORE}/raw/alex/report.pdf`, who);
    await recordRawObject(w.db, `${STORE}/raw/alex/labs.xlsx`, who);

    const res = await list(who, "alex");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: ["labs.xlsx", "report.pdf"] });
  });

  // An unclaimed namespace is refused like every other read of one, and the sealing sweep reads that
  // refusal as "nothing to seal" — a record whose first upload has not happened yet.
  it("404s for a namespace that has never held an object", async () => {
    const who = await owner("alex");

    expect((await list(who, "alex")).status).toBe(404);
  });

  it("leaves another client's objects out, so the sweep never fetches them", async () => {
    const who = await owner("alex");
    await recordRawObject(w.db, `${STORE}/raw/alex/report.pdf`, who);
    await recordRawObject(w.db, `${STORE}/raw/sam/labs.pdf`, who);

    expect(await (await list(who, "alex")).json()).toEqual({ files: ["report.pdf"] });
  });

  // Encryption is not authorisation: the listing is a read of the namespace and is gated like one.
  it("404s for an account that does not own the namespace", async () => {
    const who = await owner("alex");
    await recordRawObject(w.db, `${STORE}/raw/alex/report.pdf`, who);
    const stranger = await owner("nobody");

    expect((await list(stranger, "alex")).status).toBe(404);
  });
});
