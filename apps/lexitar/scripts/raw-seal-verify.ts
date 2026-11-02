// Does every sealed object still OPEN, and does what comes out look like the file it came from?
//
//   npm run raw:seal-verify       # needs the org key and its passphrase (docs/OPS-LOCAL.md)
//
// WHY IT MATTERS, and why `raw:seal-sweep` is not enough. That sweep measures the envelope's shape,
// which is all a run without a key can do — and an object that is sealed under a key nobody has
// measures exactly the same as one that is sealed correctly. So the format check and the openability
// check prove different things, and only this one distinguishes "encrypted" from "lost".
//
// It is the reason this exists as a command rather than as a throwaway after one sealing run: the
// in-place overwrite that seals an object is not read back (raw-encrypt-backfill.ts writes the body
// and verifies only the KEY write), so a 200 carrying wrong bytes would destroy a patient's document
// silently. This is the pass that would have caught it, and it has to be re-runnable to be worth
// anything — a check performed once, by hand, on a day nobody recorded, is not a control.
//
// THE MAGIC CHECK IS THE SECOND HALF AND THE WEAKER ONE. `getStored` throwing is the real assertion:
// it means the vault held the key and AES-GCM authenticated the body, which no accident survives.
// The leading bytes are then asked because a tag that verifies says the ciphertext is intact, not
// that the plaintext is the document — a file sealed from the wrong source would pass the first test
// and fail this one. An extension this table does not know is reported as opened and unchecked
// rather than as a failure: a `.txt` has no magic, and inventing one would fail a healthy store.
//
// WHAT A MISMATCHED EXTENSION IS, measured rather than assumed. The first production run of this
// script found one `.png` whose plaintext opens `FF D8 FF E0` — a JPEG under a PNG filename, 92,669
// bytes out of a 92,717-byte envelope, which is the header and tag exactly. Its pre-seal snapshot
// body is byte-identical to the live object, so it was sealed by the owner's own browser in
// September and nothing this operation did touched it. A file whose name disagrees with its contents
// is an ordinary upload, not a corruption — so matching ANOTHER known magic is reported and does not
// fail the run, and only plaintext that resembles no known file at all does. That is the shape
// damage would actually take: a wrong-bytes write produces something recognisable as nothing.
import "./load-creds";
import { LIVE_BUCKET, keyRef, resolveStore } from "./vault-sync";
import { getStored, parseRawKey } from "./raw-cipher-cli";
import { population } from "./raw-seal-sweep";
import { flushOrgKeyUses } from "./access-log";
import { D1 } from "./d1-remote";
import { isMain } from "./is-main";

const STORE = resolveStore();

/** Extension → the bytes a file of that kind opens with. */
const MAGIC: Record<string, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  xlsx: [0x50, 0x4b], // PK — the zip container every OOXML file is
  docx: [0x50, 0x4b],
  zip: [0x50, 0x4b],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46, 0x38],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF….WEBP; the container is what is checkable at offset 0
  heic: [0x00, 0x00, 0x00], // ftyp box length, big-endian and small
};

const startsWith = (bytes: Uint8Array, magic: number[]): boolean => magic.every((b, i) => bytes[i] === b);

type Verdict = "opened" | "unchecked" | "mislabelled" | "unrecognised" | "unopenable" | "missing";

interface Result {
  key: string;
  verdict: Verdict;
  detail?: string;
}

/** The first extension in the table whose magic these bytes carry, or null for none of them. */
const looksLike = (plain: Uint8Array): string | null =>
  Object.entries(MAGIC).find(([, magic]) => startsWith(plain, magic))?.[0] ?? null;

/** What one object's plaintext says about itself. A `text/` sidecar is the extraction JSON. */
function judge(key: string, plain: Uint8Array): Result {
  if (key.startsWith(`${STORE}/text/`)) {
    const head = new TextDecoder().decode(plain.subarray(0, 1));
    return head === "{" ? { key, verdict: "opened" } : { key, verdict: "unrecognised", detail: "a sidecar that is not JSON" };
  }
  const file = parseRawKey(key)?.file ?? "";
  const ext = (/\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? "").toLowerCase();
  const magic = MAGIC[ext];
  if (!magic) return { key, verdict: "unchecked", detail: ext ? `.${ext} has no magic to check` : "no extension" };
  if (startsWith(plain, magic)) return { key, verdict: "opened" };
  const actual = looksLike(plain);
  return actual
    ? { key, verdict: "mislabelled", detail: `named .${ext}, opens as .${actual} — an upload's own naming, not damage` }
    : { key, verdict: "unrecognised", detail: `named .${ext} and resembles no known file type` };
}

export async function verify(say: (line: string) => void): Promise<Result[]> {
  const { keys } = await population();
  say(`Target: ${D1} / ${LIVE_BUCKET} (store "${STORE}")`);
  say(`Objects to open: ${keys.length}\n`);

  const results: Result[] = [];
  // Sequential on purpose, unlike the sweep: each object may cost an org-key unwrap, every one of
  // which writes a phi_access_events row (scripts/access-log.ts), and a pool only makes that burst
  // harder to read in the log afterwards.
  for (const key of keys) {
    try {
      const plain = await getStored(key);
      results.push(plain ? judge(key, plain) : { key, verdict: "missing" });
    } catch (e) {
      results.push({ key, verdict: "unopenable", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  for (const r of results) {
      if (r.verdict === "opened" || r.verdict === "missing") continue;
    // A refusal names the key's CLASS and a hash prefix, never the key: an R2 key under `raw/` is a
    // filename the patient chose, and this command's output is pasted into reports.
    const fatal = r.verdict === "unopenable" || r.verdict === "unrecognised";
    say(`  ${fatal ? "!" : "~"} ${keyRef(r.key)}: ${r.verdict}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  say(
    `\nOpened: ${count("opened")}   opened but unchecked: ${count("unchecked")}   ` +
      `mislabelled: ${count("mislabelled")}   unrecognised: ${count("unrecognised")}   ` +
      `unopenable: ${count("unopenable")}   no object: ${count("missing")}`,
  );
  return results;
}

async function main(): Promise<void> {
  const results = await verify((line) => process.stdout.write(`${line}\n`));
  const bad = results.filter((r) => r.verdict === "unopenable" || r.verdict === "unrecognised");
  if (bad.length > 0) {
    process.stderr.write(`\nFAIL: ${bad.length} object(s) in store "${STORE}" did not open to their own contents.\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  // The flush runs on both exits, as the backfill's does: an org-key decrypt that happened must be
  // logged even when the run then fails (scripts/access-log.ts).
  main()
    .then(() => flushOrgKeyUses())
    .catch(async (e) => {
      await flushOrgKeyUses().catch(() => undefined);
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
