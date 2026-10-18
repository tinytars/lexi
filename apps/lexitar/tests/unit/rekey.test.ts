import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { namespacePairs, rekeyClient } from "../../scripts/commands/rekey";
import { renameClientKey } from "../../scripts/commands/rekey-vault";
import { classifyKey, type KeyClass } from "../../scripts/vault-sync";
import type { Vault } from "../../src/lib/types";

// G1 — a rekey that misses a namespace does not fail: it succeeds and strands that namespace's
// objects under an id nothing resolves. So the coverage below is the assertion that matters.

describe("namespacePairs", () => {
  it("maps every client-scoped key shape from the old id to the new", () => {
    expect(namespacePairs("dev", "Alex", "0b8c")).toEqual([
      ["dev/data-alex.enc", "dev/data-0b8c.enc"],
      ["dev/chat-alex.enc", "dev/chat-0b8c.enc"],
      ["dev/raw/alex/", "dev/raw/0b8c/"],
      ["dev/text/alex/", "dev/text/0b8c/"],
      ["dev/processed/alex/", "dev/processed/0b8c/"],
    ]);
  });

  // The drift guard. `logs/` is the one class R2 holds that is not client-scoped, so it is the only
  // legitimate omission; anything else new in classifyKey must be moved by a rekey too.
  it("covers every client-scoped class classifyKey knows about", () => {
    // A directory prefix needs a filename to be a key; the two exact keys already are one.
    const sample = (from: string) => (from.endsWith("/") ? `${from}f.json` : from);
    const covered = new Set(namespacePairs("dev", "old", "new").map(([from]) => classifyKey("dev", sample(from))));
    expect(covered.has(null)).toBe(false);

    const source = readFileSync(resolve(__dirname, "../../scripts/vault-sync.ts"), "utf8");
    const declared = source.match(/export type KeyClass =([^;]+);/)?.[1] ?? "";
    const classes = [...declared.matchAll(/"(\w+)"/g)].map((m) => m[1] as KeyClass);
    expect(classes.length).toBeGreaterThan(1); // the regex found the union, not an empty string

    expect(classes.filter((c) => c !== "logs" && !covered.has(c))).toEqual([]);
  });
});

describe("rekeyClient refuses a no-op", () => {
  it("rejects when old and new differ only by case, before touching R2", async () => {
    await expect(rekeyClient("Alex", "alex", "dev")).rejects.toThrow(/old and new id are the same/);
  });
});

// The companion half: --rekey-client moves R2 keys, --rekey-vault-client moves the clients map
// inside the ciphertext. Doing only the first is what 404'd every /api/raw/... on dev.
describe("renameClientKey", () => {
  const vault = () =>
    ({
      clients: {
        Alex: { displayName: "Alex", dob: "1980-01-01", gender: "male", watchlist: [], results: [{ id: "r1" }] },
        Blair: { displayName: "Blair", dob: "1982-02-02", gender: "female", watchlist: [], results: [] },
      },
    }) as unknown as Vault;

  it("renames the key, keeps the client object identical, and leaves the others alone", () => {
    const out = renameClientKey(vault(), "Alex", "834bc60d");
    expect(Object.keys(out.clients)).toEqual(["834bc60d", "Blair"]); // order preserved
    expect(out.clients["834bc60d"]).toEqual(vault().clients.Alex);
    expect(out.clients.Blair).toEqual(vault().clients.Blair);
  });

  it("does not mutate the vault it was given", () => {
    const v = vault();
    renameClientKey(v, "Alex", "834bc60d");
    expect(Object.keys(v.clients)).toEqual(["Alex", "Blair"]);
  });

  it("refuses when the old key is absent, naming what the vault actually holds", () => {
    expect(() => renameClientKey(vault(), "alex", "834bc60d")).toThrow(/"Alex", "Blair"/);
  });

  it("refuses to merge into an existing client rather than dropping its results", () => {
    expect(() => renameClientKey(vault(), "Alex", "Blair")).toThrow(/refusing to merge/);
  });
});
