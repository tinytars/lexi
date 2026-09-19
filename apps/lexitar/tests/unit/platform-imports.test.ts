import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The request path must stay host-neutral: functions/ and src/ run unchanged on Cloudflare Pages and
// on server/node.ts, so neither may reach for a host's own modules. Enforced, not intended.

const APP = fileURLToPath(new URL("../../", import.meta.url));
const FORBIDDEN = [/^cloudflare:/, /^@cloudflare\//, /^miniflare$/, /^wrangler$/, /(^|\/)server\//, /^node:(http|sqlite)$/];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|svelte)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

function platformImports(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  return specifiers.filter((s) => FORBIDDEN.some((re) => re.test(s)));
}

describe("request-path code imports no host", () => {
  it("detects each forbidden form", () => {
    expect(platformImports(`import { x } from "../../server/fs-bucket";`)).toEqual(["../../server/fs-bucket"]);
    expect(platformImports(`import type { D1Database } from "@cloudflare/workers-types";`)).toHaveLength(1);
    expect(platformImports(`const m = await import("miniflare");`)).toEqual(["miniflare"]);
    expect(platformImports(`import { env } from "cloudflare:workers";`)).toHaveLength(1);
    expect(platformImports(`import { DatabaseSync } from "node:sqlite";`)).toHaveLength(1);
    expect(platformImports(`import { json } from "../_lib/http";\nimport { x } from "@tinytars/vault/adapters/d1";`)).toEqual([]);
  });

  it.each(["functions", "src"])("%s/ is clean", (dir) => {
    const offenders = files(join(APP, dir)).flatMap((f) => platformImports(readFileSync(f, "utf8")).map((s) => `${f.slice(APP.length)}: ${s}`));
    expect(offenders).toEqual([]);
  });
});
