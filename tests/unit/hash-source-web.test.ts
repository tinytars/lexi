import { describe, it, expect } from "vitest";
import { hashSource } from "../../scripts/sources-store";
import { hashSourceWeb } from "@pablotech/akesi-pil/ingest-core";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("hashSourceWeb", () => {
  it("matches the Node hashSource sha256 + id, byte-for-byte", async () => {
    for (const s of ["hello", "world", "", "a longer clinical report string 12345", "🧬 unicode"]) {
      const node = hashSource(bytes(s));
      const web = await hashSourceWeb(bytes(s));
      expect(web).toEqual(node);
      expect(web.id).toBe(web.sha256.slice(0, 12));
    }
  });

  it("hashes a byte view with a non-zero offset correctly", async () => {
    const backing = bytes("XXXXhello");
    const view = backing.subarray(4); // offset 4, "hello"
    expect(await hashSourceWeb(view)).toEqual(hashSource(bytes("hello")));
  });
});
