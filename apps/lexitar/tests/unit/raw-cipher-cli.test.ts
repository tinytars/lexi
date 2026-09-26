// The operator side's one piece of pure logic: which vault key opens a given stored object. The rest
// of raw-cipher-cli.ts is D1, R2 and the org key, and is exercised by the sweeps that use it.
import { describe, it, expect } from "vitest";
import { parseRawKey } from "../../scripts/raw-cipher-cli";

describe("parseRawKey", () => {
  it("reads the namespace and the file out of a stored original's key", () => {
    expect(parseRawKey("prod/raw/alex/ab12cd34-report.pdf")).toEqual({ slug: "alex", file: "ab12cd34-report.pdf" });
  });

  // The transcription is sealed under the SAME content key as the document it transcribes, so both
  // resolve to one lookup — and the `.json` the sidecar adds is not part of the key's name.
  it("resolves a text sidecar to the document's own key", () => {
    expect(parseRawKey("prod/text/alex/ab12cd34-report.pdf.json")).toEqual({ slug: "alex", file: "ab12cd34-report.pdf" });
  });

  it("reads a key under any store prefix, since dev and prod share the shape", () => {
    expect(parseRawKey("dev/raw/alex/a.pdf")?.slug).toBe("alex");
  });

  it("has no key to offer for an object that is not a stored original", () => {
    expect(parseRawKey("prod/data-6f1c.enc")).toBeNull();
  });
});
