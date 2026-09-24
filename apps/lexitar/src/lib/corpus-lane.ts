// One lane for the unprompted requests that carry the report corpus, so no two of them are in the
// isolate at the same moment.
//
// WHY A LANE AND NOT A CONCURRENCY NUMBER. A corpus request is not expensive because of the vendor;
// it is expensive because of where it is assembled. Every PDF in the record is read from R2 and
// base64'd into the request body, so ONE call holds tens of megabytes inside the Pages Function that
// serves it — and a Function's 128 MB ceiling is per ISOLATE, shared by every request it happens to
// be running. Opening a record fired a corpus-warm and a six-node leaf sweep within a second of each
// other; Cloudflare killed the isolate for exceededResources, and the kill takes down every request
// in flight, including ones that had nothing to do with the corpus. The browser then saw a 503 no
// handler wrote, on whatever routes were unlucky, and filed each as a separate bug.
//
// WHAT DOES NOT BELONG HERE. A user's own turn — a chat question, a Translate click — is one request
// at a time and is what the person is waiting for. Queueing it behind background work would trade an
// invisible problem for a visible one. This lane is for the work nobody asked for.
//
// W85's SWEEP_CONCURRENCY was the same shape for a different ceiling (the vendor's per-minute rate
// limit) and is subsumed by this one: a lane of one is under every limit either of them had.

export interface CorpusLane {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createCorpusLane(): CorpusLane {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(task);
      // The queue chains on a SETTLED tail, never on `result` itself: one failing task must not
      // strand everything behind it, and the caller still sees the real rejection.
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
