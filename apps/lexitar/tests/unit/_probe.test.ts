import { describe, it, expect } from "vitest";
import { installApiFailureReporting, installErrorReporter, type ClientErrorPayload } from "../../src/lib/error-reporter";

// The fetch wrapper decides "did a handler classify this 5xx?" by reading the body for an
// `errorCode`. Every model-backed call in this app runs under `withDeadline` (ai-error.ts), which
// hands the request an AbortSignal and fires it on the wall-clock limit — and the wrapper's own read
// of the body happens INSIDE that window, because it runs before the response is handed back.
//
// So a relay that answered with its classified code, and whose body then stops arriving, reaches the
// wrapper as a read that throws rather than as "no errorCode here". Treating the two the same files
// the condition the app already retries and explains as a defect — the report this check exists to
// stop, filed anyway.

function setup() {
  const sent: ClientErrorPayload[] = [];
  installErrorReporter(new EventTarget(), (p) => sent.push(p));
  return sent;
}

/** A body that yields its first chunk, then fails the way an aborted request's stream does. */
function cutShort(status: number, controller: AbortController): Response {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulls++ === 0) {
        c.enqueue(new TextEncoder().encode('{"errorCo'));
        return;
      }
      controller.abort();
      c.error(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("installApiFailureReporting: a 5xx the app stopped waiting for", () => {
  it("does not file one whose body the request's own abort cut short", async () => {
    const sent = setup();
    const ctrl = new AbortController();
    const scope = { fetch: (async () => cutShort(503, ctrl)) as unknown as typeof fetch };
    installApiFailureReporting(scope, "https://lexitar.example");

    await scope.fetch("https://lexitar.example/api/refresh-range", { method: "POST", signal: ctrl.signal });

    expect(sent).toEqual([]);
  });

  // The abort is the whole reason to hold back. A body that simply fails to arrive on a request
  // nobody cancelled is still a route that answered nothing readable, and still worth a report.
  it("still files one whose body failed on a request nobody cancelled", async () => {
    const sent = setup();
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => c.error(new TypeError("network error")),
    });
    const scope = {
      fetch: (async () =>
        new Response(body, { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    };
    installApiFailureReporting(scope, "https://lexitar.example");

    await scope.fetch("https://lexitar.example/api/refresh-range", { method: "POST" });

    expect(sent.map((p) => p.message)).toEqual(["POST /api/refresh-range → 503"]);
  });
});
