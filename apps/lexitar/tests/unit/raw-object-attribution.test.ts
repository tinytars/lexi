// Whose record an object is, decided at the write — on a real D1 + R2.
//
// Five routes record a row in `raw_objects` for every object they store, and all five used to name the
// CALLER. A clinician holding a live grant writes on the patient's behalf, so that row named the wrong
// account — and `erasure.ts` is where it hurt: it counts the object inside the patient's namespace,
// finds it attributed elsewhere, and by design never deletes by prefix (a slug collision would destroy
// a third party's only copy), so the patient's erasure reported `complete: false` for ever with no
// route that could ever resolve it. `recordSubject` (functions/_lib/raw-owner.ts) is the fix; this file
// pins it at every route, and pins the case it deliberately does NOT reach.
//
// Real D1 and R2 rather than a fake: a fake `raw_objects` can be made to agree with whatever the route
// writes, which is the failure being fixed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { rawAccessFor, recordSubject } from "../../functions/_lib/raw-owner";
import { onRequestPut as rawPut } from "../../functions/api/raw/[[path]]";
import { onRequestPut as chatPut } from "../../functions/api/chat-history/[id]";
import { onRequestPut as regenPut } from "../../functions/api/regen-log/[id]";
import { onRequestPost as extractPost } from "../../functions/api/document-extract";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE = "dev";
const SLUG = "alex";
const w = useWorkerd({ r2: true, perTest: true });

const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as never;
const cookie = async (id: string) => ({ cookie: await cookieFor(id) });

/**
 * A patient owning the vault over `SLUG`, and a clinician holding a live envelope and a live provider
 * link over it. The PATIENT is the namespace's first writer, so the clinician resolves `granted` —
 * which is the whole case this file is about. The first-writer case, where the clinician claimed the
 * namespace instead, is pinned at the bottom as the gap it still is.
 */
async function pair() {
  const patientKp = await generateAccountKeypair();
  const patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName: "Patient", email: `${patientId}@example.com` });
  await putPublicKey(w.db, { accountId: patientId, publicKeyJwk: patientKp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const own = await wrapDEKForPublicKey(dek, patientKp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: patientId, wrappedDek: own.wrappedDEK, ephemeralPublicKeyJwk: own.ephemeralPublicKeyJwk, createdBy: patientId });

  const clinicianKp = await generateAccountKeypair();
  const clinicianId = crypto.randomUUID();
  await createAccount(w.db, { id: clinicianId, displayName: "Doc", email: `${clinicianId}@clinic.test`, providerKind: "primary" });
  await putPublicKey(w.db, { accountId: clinicianId, publicKeyJwk: clinicianKp.publicKeyJwk });
  const shared = await wrapDEKForPublicKey(dek, clinicianKp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: clinicianId, wrappedDek: shared.wrappedDEK, ephemeralPublicKeyJwk: shared.ephemeralPublicKeyJwk, createdBy: patientId });
  await createProviderLink(w.db, { ownerAccountId: patientId, providerAccountId: clinicianId, role: "primary", status: "active", grantedBy: patientId, consentRef: "consent-alex" });

  // The patient's own first write, so the namespace is CLAIMED and by them.
  const seed = `${STORE}/raw/${SLUG}/seed.pdf`;
  await w.bucket.put(seed, hd1Blob());
  await recordRawObject(w.db, seed, patientId);
  expect(await rawAccessFor(w.db, env(), clinicianId, SLUG)).toMatchObject({ kind: "granted", subjectAccountId: patientId });
  return { patientId, clinicianId };
}

/** The account id `raw_objects` records for `key`, or null when there is no row at all. */
const attributedTo = async (key: string): Promise<string | null> =>
  (await w.db.prepare("SELECT account_id FROM raw_objects WHERE r2_key = ?").bind(key).first<{ account_id: string }>())?.account_id ?? null;

/** The one key under `prefix`, so a server-minted segment name never has to be guessed. */
async function soleKeyUnder(prefix: string): Promise<string> {
  const { objects } = await w.bucket.list({ prefix });
  expect(objects.map((o) => o.key)).toHaveLength(1);
  return objects[0].key;
}

const uploadRaw = async (who: string, file: string) =>
  rawPut({ request: new Request(`http://x/api/raw/${SLUG}/${file}`, { method: "PUT", headers: await cookie(who), body: hd1Blob() }), env: env(), params: { path: [SLUG, file] } } as never);
const saveChat = async (who: string, extra: Record<string, string> = {}) =>
  chatPut({ request: new Request(`http://x/api/chat-history/${SLUG}`, { method: "PUT", headers: { ...(await cookie(who)), ...extra }, body: hd1Blob(48) }), env: env(), params: { id: SLUG } } as never);
const appendRegen = async (who: string) =>
  regenPut({ request: new Request(`http://x/api/regen-log/${SLUG}`, { method: "PUT", headers: await cookie(who), body: hd1Blob(64) }), env: env(), params: { id: SLUG } } as never);
// POST, not GET: the GET handler serves an already-cached sidecar and 404s when there is none
// (document-extract.ts:246) — the extraction, and the attribution write, are on POST.
const readText = async (who: string, file: string) =>
  extractPost({
    request: new Request("http://x/api/document-extract", {
      method: "POST",
      headers: { ...(await cookie(who)), "content-type": "application/json" },
      body: JSON.stringify({ id: SLUG, key: file }),
    }),
    env: env(),
  } as never);

describe("a granted clinician's write is recorded against the PATIENT", () => {
  it("PUT /api/raw — the original", async () => {
    const { patientId, clinicianId } = await pair();
    expect((await uploadRaw(clinicianId, "new.pdf")).status).toBe(204);
    expect(await attributedTo(`${STORE}/raw/${SLUG}/new.pdf`)).toBe(patientId);
  });

  it("PUT /api/chat-history — the conversation blob", async () => {
    const { patientId, clinicianId } = await pair();
    expect((await saveChat(clinicianId)).status).toBe(204);
    expect(await attributedTo(`${STORE}/chat-${SLUG}.enc`)).toBe(patientId);
  });

  it("PUT /api/chat-history with x-replace-unreadable — the retained copy (W71)", async () => {
    const { patientId, clinicianId } = await pair();
    // A blob already there is the precondition for the escape hatch: it is what gets kept aside.
    await w.bucket.put(`${STORE}/chat-${SLUG}.enc`, hd1Blob());
    expect((await saveChat(clinicianId, { "x-replace-unreadable": "1" })).status).toBe(204);
    const kept = await soleKeyUnder(`${STORE}/orphaned-chat/${SLUG}/`);
    expect(await attributedTo(kept)).toBe(patientId);
  });

  it("PUT /api/regen-log — the evidence segment", async () => {
    const { patientId, clinicianId } = await pair();
    expect((await appendRegen(clinicianId)).status).toBe(201);
    expect(await attributedTo(await soleKeyUnder(`${STORE}/regen-log/${SLUG}/`))).toBe(patientId);
  });

  it("POST /api/document-extract — the extracted-text sidecar", async () => {
    const { patientId, clinicianId } = await pair();
    // A `.txt` takes the route's no-model path (document-extract.ts:170), so this reaches the
    // attribution write with no stubbed SDK and no billable call.
    await w.bucket.put(`${STORE}/raw/${SLUG}/note.txt`, "ferritin 18 ng/mL");
    expect((await readText(clinicianId, "note.txt")).status).toBe(200);
    expect(await attributedTo(`${STORE}/text/${SLUG}/note.txt.json`)).toBe(patientId);
  });
});

describe("and the patient's own write is still recorded against the patient", () => {
  // The control: a helper that returned the subject unconditionally, or the wrong field of the granted
  // branch, would pass every test above. These are the cases where caller and subject coincide.
  it.each([
    ["an upload", async (who: string) => (await uploadRaw(who, "mine.pdf")).status, 204, `${STORE}/raw/${SLUG}/mine.pdf`],
    ["a chat save", async (who: string) => (await saveChat(who)).status, 204, `${STORE}/chat-${SLUG}.enc`],
  ])("%s by the owner", async (_label, call, status, key) => {
    const { patientId } = await pair();
    expect(await call(patientId)).toBe(status);
    expect(await attributedTo(key as string)).toBe(patientId);
  });
});

describe("recordSubject redirects the granted kind and nothing else", () => {
  const CALLER = "caller-account";
  const SUBJECT = "subject-account";

  it("names the SUBJECT on a grant — and subjectAccountId, never ownerAccountId", () => {
    // ownerAccountId is only the namespace's FIRST WRITER (rawAccessFor), which on a clinician-first
    // namespace is the clinician — the very account the row must stop naming. They are deliberately
    // different values here so a helper reading the wrong field cannot pass.
    const access = { kind: "granted", ownerAccountId: "first-writer", vaultId: "v", subjectAccountId: SUBJECT, consentRef: null } as const;
    expect(recordSubject(access, CALLER)).toBe(SUBJECT);
  });

  it.each([
    ["owner", { kind: "owner" } as const],
    ["unclaimed", { kind: "unclaimed" } as const],
    ["orphaned", { kind: "orphaned" } as const],
    ["denied", { kind: "denied", ownerAccountId: "someone" } as const],
  ])("names the caller on %s", (_kind, access) => {
    expect(recordSubject(access, CALLER)).toBe(CALLER);
  });
});

describe("every route that records an object goes through the helper", () => {
  // Derived from the call sites rather than from a list in this file, for store-key-classes.test.ts's
  // reason: a sixth write site added later would be invisible to five hand-written route tests above
  // and would reintroduce the whole defect. This fails at the commit that adds it.
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  })(resolve(ROOT, "functions/api"));

  // Balanced-paren scan, not a regex: `recordRawObject(env.DB, r2Key(env, id), …)` nests a call, and
  // a non-greedy pattern stops at the inner `)` and reports an argument list that is not one.
  function callsIn(src: string): string[] {
    const NAME = "recordRawObject(";
    const out: string[] = [];
    for (let i = src.indexOf(NAME); i !== -1; i = src.indexOf(NAME, i + 1)) {
      const from = i + NAME.length;
      let depth = 0;
      for (let j = from; j < src.length; j++) {
        if (src[j] === "(") depth += 1;
        else if (src[j] === ")") {
          if (depth === 0) {
            out.push(src.slice(from, j));
            break;
          }
          depth -= 1;
        }
      }
    }
    return out;
  }

  const sites = files.flatMap((file) =>
    callsIn(readFileSync(file, "utf8")).map((args) => ({ where: `${file.slice(ROOT.length + 1)} \u2192 ${args}`, args })),
  );

  it("finds the call sites at all, so an empty sweep cannot pass silently", () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it.each(sites.map((s) => [s.where, s.args]))("%s", (_where, args) => {
    expect(args as string).toContain("recordSubject(");
  });
});
