// The response shape both refresh routes answer with: plain text, produced as it is generated, with
// no buffering anywhere between the model and the browser.
//
// WHY THE HEADERS ARE HERE AND NOT IN THE ROUTES. `no-store` and `x-accel-buffering: no` are what
// make the stream a stream; a route that copied two of the three headers would look like it worked
// and arrive all at once. They belong with the construction, once.

/**
 * Streams whatever `pump` writes, and closes the stream when it settles — including when it throws,
 * which is how a route's in-band failure sentinel still reaches the browser.
 *
 * `write` rather than the raw controller: every caller enqueues UTF-8 text, so the encoder lives
 * here instead of in each route.
 */
export function textStream(pump: (write: (text: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await pump((text) => controller.enqueue(encoder.encode(text)));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
