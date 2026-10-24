import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { namespacePrefixes } from "../../functions/_lib/raw-owner";
import { clientIdOfObjectKey, erasedClientIdOfObjectKey } from "../../functions/_lib/namespace-key";

// "Which namespace is this object in" has TWO correct answers, and they must not be one function.
//
// raw-owner.ts's namespacePrefixes claims four shapes — raw/, text/, regen-log/ and the flat
// chat-{id}.enc — and `orphaned-chat/` is DELIBERATELY not among them: the W71 escape hatch's retained
// copy must be claimable by nobody. But erasure.ts's NAMESPACED_PREFIXES does count it, because an
// erasure has to find it. So an object can sit inside a patient's namespace for the purpose of erasing
// them while belonging to no claimable namespace at all, and a single parser answering both questions
// is wrong against one of them whichever way it is written.
//
// Both expectations are derived from the other side rather than enumerated here — the ownership set by
// calling namespacePrefixes, the erasure set by reading erasure.ts's literal, since it is not exported
// (same shape as store-key-classes.test.ts). So adding a prefix to either side fails HERE, in the
// suite, at the commit that adds it, instead of silently agreeing with whatever the parser already did.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE = "dev";
const SLUG = "alex";
const env = { STORE_PREFIX: STORE } as never;

/** The DIRECTORY prefixes namespacePrefixes claims, read off its own return value. */
const ownedDirs = namespacePrefixes(env, SLUG)
  .filter((p) => p.endsWith("/"))
  .map((p) => p.slice(`${STORE}/`.length, -`/${SLUG}/`.length));

/** The flat keys it claims — today exactly `chat-{id}.enc`, which has no directory segment at all. */
const ownedFlat = namespacePrefixes(env, SLUG).filter((p) => !p.endsWith("/"));

/** erasure.ts's NAMESPACED_PREFIXES, which is module-private, so it is read from the source. */
const erasedDirs = (() => {
  const src = readFileSync(resolve(ROOT, "functions/_lib/erasure.ts"), "utf8");
  const m = /const NAMESPACED_PREFIXES = \[([^\]]+)\]/.exec(src);
  if (!m) throw new Error("erasure.ts no longer declares NAMESPACED_PREFIXES as an array literal");
  return [...m[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map((x) => x[1]);
})();

describe("the two prefix sets are read from their own sources, not from this file", () => {
  it("finds both, so an empty sweep cannot pass silently", () => {
    expect(ownedDirs).toEqual(expect.arrayContaining(["raw", "text"]));
    expect(ownedFlat).toHaveLength(1);
    expect(erasedDirs).toEqual(expect.arrayContaining(["raw", "text"]));
  });

  // If this ever reads zero, the two questions have converged and this whole file is moot — which is a
  // decision somebody should have to make on purpose, not a test quietly going green.
  it("the erasure set is strictly larger, which is why there are two parsers", () => {
    expect(erasedDirs.filter((d) => !ownedDirs.includes(d))).not.toHaveLength(0);
  });
});

describe("clientIdOfObjectKey answers OWNERSHIP", () => {
  it.each(ownedDirs)("resolves a key under %s/, which raw-owner.ts claims", (dir) => {
    expect(clientIdOfObjectKey(`${STORE}/${dir}/${SLUG}/file.ext`)).toBe(SLUG);
  });

  it.each(ownedFlat)("resolves the flat key %s", (key) => {
    expect(clientIdOfObjectKey(key)).toBe(SLUG);
  });

  it.each(erasedDirs.filter((d) => !ownedDirs.includes(d)))("refuses %s/, which NOBODY may claim", (dir) => {
    expect(clientIdOfObjectKey(`${STORE}/${dir}/${SLUG}/file.ext`)).toBeNull();
  });
});

describe("erasedClientIdOfObjectKey answers ERASURE, which is a larger set", () => {
  it.each(erasedDirs)("resolves a key under %s/, which erasure.ts counts", (dir) => {
    expect(erasedClientIdOfObjectKey(`${STORE}/${dir}/${SLUG}/file.ext`)).toBe(SLUG);
  });

  it.each(ownedFlat)("resolves the flat key %s too", (key) => {
    expect(erasedClientIdOfObjectKey(key)).toBe(SLUG);
  });
});

describe("neither parser claims a key that is in no namespace", () => {
  // The vault blob. It is `data-{uuid}.enc`, one hyphenated segment away from `chat-{id}.enc`, and a
  // parser that took it for a chat key would attribute a whole account's vault to a client slug.
  const vault = `${STORE}/data-8dafade9-9f33-426d-bb35-1f63ae168212.enc`;

  it.each([
    ["the vault blob", vault],
    ["a store-root key with no client segment", `${STORE}/logs/2026-10-24.json`],
    ["a key with no store prefix at all", `raw/${SLUG}/file.pdf`],
  ])("%s resolves to neither owner nor erasure subject", (_label, key) => {
    expect(clientIdOfObjectKey(key)).toBeNull();
    expect(erasedClientIdOfObjectKey(key)).toBeNull();
  });
});

describe("a namespace segment is normalized the same way on both answers", () => {
  it.each(["ALEX", "Alex"])("%s resolves to the lowercased slug", (raw) => {
    expect(clientIdOfObjectKey(`${STORE}/raw/${raw}/f.pdf`)).toBe(SLUG);
    expect(erasedClientIdOfObjectKey(`${STORE}/orphaned-chat/${raw}/f.enc`)).toBe(SLUG);
  });
});
