import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Pages Functions' file-based routing, reproduced so the Node host serves the same functions/ tree
// Cloudflare does — one source of which routes exist. `[x]` binds one segment, `[[x]]` the rest (an
// array, possibly empty), `index` names its directory; static beats param beats catch-all.

type Segment = { kind: "static"; value: string } | { kind: "param"; name: string } | { kind: "catchall"; name: string };

export interface RouteFile {
  file: string;
  segments: Segment[];
}

export type Params = Record<string, string | string[]>;

function toSegment(part: string): Segment {
  const catchall = /^\[\[(\w+)\]\]$/.exec(part);
  if (catchall) return { kind: "catchall", name: catchall[1] };
  const param = /^\[(\w+)\]$/.exec(part);
  if (param) return { kind: "param", name: param[1] };
  return { kind: "static", value: part };
}

const RANK = { static: 0, param: 1, catchall: 2 } as const;

function compareSpecificity(a: RouteFile, b: RouteFile): number {
  for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
    const d = RANK[a.segments[i].kind] - RANK[b.segments[i].kind];
    if (d) return d;
  }
  return b.segments.length - a.segments.length;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

// `root` is the functions/ directory; files under a `_`-prefixed directory are libraries, not routes.
export function discoverRoutes(root: string): RouteFile[] {
  return walk(root)
    .filter((file) => !relative(root, file).split(sep).some((p) => p.startsWith("_")))
    .map((file) => {
      const parts = relative(root, file).slice(0, -".ts".length).split(sep);
      if (parts[parts.length - 1] === "index") parts.pop();
      return { file, segments: parts.map(toSegment) };
    })
    .sort(compareSpecificity);
}

export function matchRoute(route: RouteFile, pathname: string): Params | null {
  const parts = pathname.split("/").filter(Boolean);
  const params: Params = {};
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i];
    if (seg.kind === "catchall") {
      params[seg.name] = parts.slice(i);
      return params;
    }
    if (i >= parts.length) return null;
    if (seg.kind === "static" && seg.value !== parts[i]) return null;
    if (seg.kind === "param") params[seg.name] = parts[i];
  }
  return parts.length === route.segments.length ? params : null;
}

export type Handler = (context: { request: Request; env: unknown; params: Params; waitUntil(p: Promise<unknown>): void }) => Promise<Response> | Response;

export interface LoadedRoute extends RouteFile {
  module: Record<string, unknown>;
}

export async function loadRoutes(root: string): Promise<LoadedRoute[]> {
  return Promise.all(discoverRoutes(root).map(async (r) => ({ ...r, module: (await import(r.file)) as Record<string, unknown> })));
}

const methodExport = (method: string) => `onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`;

// Like Pages, a route without a handler for the method is skipped rather than answered with a 405, so
// the request falls through to the next match and finally to static assets.
export function selectHandler(routes: LoadedRoute[], method: string, pathname: string): { handler: Handler; params: Params } | null {
  for (const route of routes) {
    const handler = (route.module[methodExport(method)] ?? route.module.onRequest) as Handler | undefined;
    if (!handler) continue;
    const params = matchRoute(route, pathname);
    if (params) return { handler, params };
  }
  return null;
}
