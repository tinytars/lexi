import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

// Static serving with Pages' semantics for the parts this app relies on: `_headers` rules applied to
// asset responses, `dir/` → `dir/index.html`, a missing path answered 404 by the nearest ancestor
// directory's 404.html, and every other unknown path answered with the SPA's index.html, the way
// Pages' single-page-app mode does.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

export interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

// `_headers`: an unindented URL pattern (`*` a splat, `:name` one segment) followed by indented
// `Name: value` lines.
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const source = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:\w+/g, "[^/]+");
      rules.push({ pattern: new RegExp(`^${source}$`), headers: [] });
      continue;
    }
    const at = line.indexOf(":");
    rules.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return rules;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function assetServer(distDir: string): (request: Request) => Promise<Response> {
  const root = resolve(distDir);
  const headersFile = join(root, "_headers");
  const rules = isFile(headersFile) ? parseHeaders(readFileSync(headersFile, "utf8")) : [];

  const locate = (pathname: string): { file: string; status: number } => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = "/";
    }
    const target = resolve(root, "." + decoded);
    if (target === root || target.startsWith(root + sep)) {
      for (const candidate of [target, join(target, "index.html"), target + ".html"]) if (isFile(candidate)) return { file: candidate, status: 200 };
      for (let dir = dirname(target); dir.startsWith(root + sep); dir = dirname(dir)) {
        if (isFile(join(dir, "404.html"))) return { file: join(dir, "404.html"), status: 404 };
      }
    }
    return { file: join(root, "index.html"), status: 200 };
  };

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const { pathname } = new URL(request.url);
    const { file, status } = locate(pathname);
    const headers = new Headers({ "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    for (const rule of rules) if (rule.pattern.test(pathname)) for (const [k, v] of rule.headers) headers.set(k, v);
    return new Response(request.method === "HEAD" ? null : readFileSync(file), { status, headers });
  };
}
