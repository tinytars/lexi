import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  r2KeyFor,
  r2RefFor,
  r2RawKeyFor,
  pullArgs,
  pushArgs,
  resolveStore,
} from "../../scripts/vault-sync";
import { wranglerTarget } from "../../scripts/target";

// Pins the R2 key/ref derivation and the wrangler arg arrays. The key MUST match the
// browser/Function key ({store}/data-{id}.enc) and the CLI's perClientPath (lowercase id),
// or the CLI and the web app would read/write different objects. The shell-out + real R2
// are verified live (see VAULT.md / the W6e verification), not here.
//
// W53 P4: the bucket and the default store are no longer constants — they come from the worktree's
// wrangler.jsonc, so `dev` and `main` legitimately produce different refs. These tests therefore
// assert against the branch's DECLARED config, parsed here independently rather than by calling the
// same resolver, so they still fail if the derivation is wrong and pass from either worktree.
const here = dirname(fileURLToPath(import.meta.url));
const declared = (() => {
  const raw = readFileSync(resolve(here, "../../wrangler.jsonc"), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const cfg = JSON.parse(raw);
  return {
    bucket: cfg.r2_buckets[0].bucket_name as string,
    database: cfg.d1_databases[0].database_name as string,
    storePrefix: cfg.vars.STORE_PREFIX as string,
  };
})();

describe("wranglerTarget", () => {
  it("reports the bucket, database and store this branch's wrangler.jsonc declares", () => {
    const t = wranglerTarget();
    expect(t.bucket).toBe(declared.bucket);
    expect(t.database).toBe(declared.database);
    expect(t.storePrefix).toBe(declared.storePrefix);
  });
  it("keeps bucket, database and store on the same side of the dev/prod split", () => {
    // The whole point of deriving all three from one file is that a prod bucket can never be paired
    // with a dev database. Catch a half-edited wrangler.jsonc here rather than at a cutover.
    const t = wranglerTarget();
    const isProd = t.storePrefix === "prod";
    expect(t.bucket.endsWith("-prod")).toBe(isProd);
    expect(t.database.endsWith("-prod")).toBe(isProd);
  });
});

describe("vault-sync key derivation", () => {
  it("keys by lowercased id as {store}/data-{id}.enc, matching the slice filename", () => {
    expect(r2KeyFor("dev", "pablo")).toBe("dev/data-pablo.enc");
    expect(r2KeyFor("dev", "Pablo")).toBe("dev/data-pablo.enc"); // CLI passes capitalized ids
    expect(r2KeyFor("prod", "Liz")).toBe("prod/data-liz.enc");
  });
  it("raw key mirrors the on-disk records/private/{id}/raw layout, prefixed by store", () => {
    expect(r2RawKeyFor("dev", "Pablo", "x-597cd4e7.pdf")).toBe("dev/raw/pablo/x-597cd4e7.pdf");
  });
  it("refs the bucket this branch binds, and never a hardcoded one", () => {
    expect(r2RefFor("dev", "Pablo")).toBe(`${declared.bucket}/dev/data-pablo.enc`);
  });
});

describe("resolveStore", () => {
  it("prefers an explicit store, else STORE_PREFIX, else this branch's declared prefix", () => {
    expect(resolveStore("branch-x")).toBe("branch-x");
    const prev = process.env.STORE_PREFIX;
    process.env.STORE_PREFIX = "from-env";
    expect(resolveStore()).toBe("from-env");
    delete process.env.STORE_PREFIX;
    // Used to default to the literal "dev", which meant running from the main worktree built dev/…
    // keys against prod's bucket and silently found nothing.
    expect(resolveStore()).toBe(declared.storePrefix);
    if (prev !== undefined) process.env.STORE_PREFIX = prev;
  });
  it("throws on an empty explicit store (never builds an unprefixed key)", () => {
    expect(() => resolveStore("   ")).toThrow(/empty store prefix/);
  });
});

describe("vault-sync wrangler arg arrays", () => {
  it("pull = r2 object get <ref> --remote --file <dest>", () => {
    const a = pullArgs("dev", "Pablo", "/tmp/x.enc");
    expect(a).toEqual([
      "wrangler", "r2", "object", "get",
      `${declared.bucket}/dev/data-pablo.enc`,
      "--remote", "--file", "/tmp/x.enc",
    ]);
  });
  it("push = r2 object put <ref> --remote --file <local slice>", () => {
    const a = pushArgs("dev", "Liz");
    expect(a.slice(0, 6)).toEqual([
      "wrangler", "r2", "object", "put",
      `${declared.bucket}/dev/data-liz.enc`,
      "--remote",
    ]);
    expect(a[6]).toBe("--file");
    expect(a[7]).toMatch(/records\/public\/data-liz\.enc$/);
  });
  it("--remote is present (without it wrangler hits a local sim bucket, not the cloud)", () => {
    expect(pullArgs("dev", "x", "/t")).toContain("--remote");
    expect(pushArgs("dev", "x")).toContain("--remote");
  });
});
