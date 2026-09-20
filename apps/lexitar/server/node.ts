import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { reportServerError, type ServerErrorEnv } from "../functions/_lib/server-error";
import { createApp, type Fetch } from "./app";
import { assetServer } from "./assets";
import { FsBucket } from "./fs-bucket";
import { applyPendingMigrations } from "./migrations";
import { loadRoutes } from "./routes";
import { SqliteD1Database } from "./sqlite-d1";

// The Node self-host: the same functions/ tree and dist/ Cloudflare Pages serves, bound to SQLite and
// a directory of blobs. A proof of portability, not a second production — no TLS, no backups.
//
//   node --import tsx server/node.ts                 serve on $PORT (default 8788)
//   node --import tsx server/node.ts seed a.sql ...  apply migrations, execute each file, exit

const APP = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = process.env.LEXI_DATA_DIR ?? join(APP, ".node-data");
const DIST_DIR = process.env.LEXI_DIST_DIR ?? join(APP, "dist");
const REQUIRED = ["SESSION_SECRET", "STORE_PREFIX"];

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, values] of Object.entries(req.headersDistinct)) for (const v of values ?? []) headers.append(name, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  await new Promise<void>((resolve, reject) =>
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res).on("finish", resolve).on("error", reject),
  );
}

function serve(app: Fetch, port: number): void {
  createServer((req, res) => {
    app(toRequest(req))
      .then((response) => send(response, res))
      .catch((e) => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  }).listen(port, () => console.log(`lexitar (node host) on http://localhost:${port}`));
}

async function main(): Promise<void> {
  const [command, ...files] = process.argv.slice(2);
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new SqliteD1Database(join(DATA_DIR, "lexi.sqlite"));
  const applied = applyPendingMigrations(db);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);

  if (command === "seed") {
    for (const f of files) db.db.exec(readFileSync(f, "utf8"));
    db.close();
    return;
  }

  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new Error(`refusing to start: ${missing.join(", ")} unset`);
  const app = createApp({
    routes: await loadRoutes(join(APP, "functions")),
    env: { ...process.env, DB: db, VAULT: new FsBucket(join(DATA_DIR, "blobs")) },
    assets: assetServer(DIST_DIR),
  });
  serve(app, Number(process.env.PORT ?? 8788));
}

// A crash outside any request — a rejected background task, a throw in a timer — would otherwise end
// the process (or silently not) with nothing but a line on the operator's terminal. Reporting is
// capped at 3 s because the process is on its way out and GitHub may be the thing that is broken.
function reportFatal(kind: "unhandledRejection" | "uncaughtException", e: unknown): Promise<unknown> {
  console.error(`${kind}:`, e);
  return Promise.race([
    reportServerError(process.env as ServerErrorEnv, e, { route: `(${kind})`, method: "-", deployment: "node-host" }),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

process.on("unhandledRejection", (e) => void reportFatal("unhandledRejection", e));
process.on("uncaughtException", (e) => void reportFatal("uncaughtException", e).then(() => process.exit(1)));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
