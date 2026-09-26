// How long the isolate budget a corpus reserves is held for, which is the whole point of the scope:
// `inference-one-door.test.ts` pins WHAT the door hands a route, this pins WHEN it gives the memory
// back. Real R2 and real D1, because the reservation is sized from the row the storage holds.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withAttachedModel, streamWithAttachedModel, type AttachedEnv } from "../../functions/_lib/inference/attach";
import { CorpusBusyError } from "../../functions/_lib/inference/corpus-errors";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import type { Subject } from "../../functions/_lib/inference/subject";
import { useWorkerd } from "../support/miniflare";

const STORE = "dev";
const w = useWorkerd({ r2: true, perTest: true });

const env = () =>
  ({ ANTHROPIC_API_KEY: "test-key", DB: w.db, VAULT: w.bucket, STORE_PREFIX: STORE, REPORTS: "always" }) as unknown as AttachedEnv;

/** One report whose bytes were never measured, so it reserves the whole MAX_CORPUS_BYTES ceiling and
 *  a second attached request cannot fit beside it — the deterministic way to observe the window. */
async function clientWithUnmeasuredReport(slug: string): Promise<Subject> {
  const accountId = crypto.randomUUID();
  await createAccount(w.db, { id: accountId, displayName: slug, email: `${slug}-${accountId}@example.com` });
  const key = `${STORE}/raw/${slug}/report.pdf`;
  await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 one"));
  await recordRawObject(w.db, key, accountId, { pages: 3 });
  return { accountId, clientId: slug, rawKeys: {} };
}

const attachAgain = (who: Subject) => withAttachedModel(env(), "chat", who, async ({ corpus }) => corpus.docCount);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe("streamWithAttachedModel", () => {
  // The two refresh routes answer 200 and keep generating, so the corpus is live long after the
  // handler returned. A release on the handler's own return would leave exactly the gap this fix
  // closes, only narrower and harder to see.
  it("holds the reservation until the stream ends, not until the Response is returned", async () => {
    const who = await clientWithUnmeasuredReport("alex");
    const held = gate();

    const response = await streamWithAttachedModel(env(), "finding", who, async ({ corpus }, write) => {
      write(`docs:${corpus.docCount}`);
      await held.opened;
    });

    await expect(attachAgain(who)).rejects.toBeInstanceOf(CorpusBusyError);

    held.open();
    await expect(response.text()).resolves.toBe("docs:1");
    await expect(attachAgain(who)).resolves.toBe(1);
  });

  it("gives the reservation back when the pump throws", async () => {
    const who = await clientWithUnmeasuredReport("alex");

    const response = await streamWithAttachedModel(env(), "finding", who, async () => {
      throw new Error("generation died mid-stream");
    });
    await response.text();

    await expect(attachAgain(who)).resolves.toBe(1);
  });
});

// The release token is the one thing that can wedge an isolate's budget permanently, so it is
// reachable from attach.ts and nowhere else. A route that imported the assembler directly would get
// a `release` of its own to forget — which is the failure mode the scopes exist to make impossible.
describe("openReportCorpus", () => {
  it("is imported by attach.ts and by no other module", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const sources = ["functions", "src", "scripts", "server"].flatMap((dir) =>
      readdirSync(resolve(root, dir), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => resolve(e.parentPath, e.name)),
    );

    const importers = sources.filter((file) => /import[^;]*openReportCorpus[^;]*from/.test(readFileSync(file, "utf8")));

    expect(importers.map((f) => relative(root, f))).toEqual(["functions/_lib/inference/attach.ts"]);
  });
});
