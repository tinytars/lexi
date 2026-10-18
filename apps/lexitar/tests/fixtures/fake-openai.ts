// A real HTTP server that speaks just enough of OpenAI's /v1/chat/completions for the adapter to be
// tested over the wire: it records every request and answers with whatever the test queued, either a
// JSON completion or a list of SSE chunks.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeReply =
  | { json: unknown; status?: number }
  | { sse: unknown[] };

export interface FakeRequest {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

export interface FakeOpenAI {
  baseUrl: string;
  requests: FakeRequest[];
  reply(r: FakeReply): void;
  close(): Promise<void>;
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const requests: FakeRequest[] = [];
  const queue: FakeReply[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "no reply queued" } }));
      } else if ("json" in next) {
        res.writeHead(next.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(next.json));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split each event across two writes so the client's line buffering is exercised.
        for (const chunk of next.sse) {
          const line = `data: ${JSON.stringify(chunk)}\n\n`;
          res.write(line.slice(0, 7));
          res.write(line.slice(7));
        }
        res.end("data: [DONE]\n\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (r) => queue.push(r),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
