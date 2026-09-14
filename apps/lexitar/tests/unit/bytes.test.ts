import { describe, it, expect } from "vitest";
import { toArrayBuffer } from "../../functions/_lib/bytes";

// W72 — this replaced `bytes as unknown as ArrayBuffer` at two key-import sites. The cast type-checked
// a false claim, and WebCrypto accepting a Uint8Array at runtime is what kept it invisible.
describe("toArrayBuffer", () => {
  it("hands back the same bytes for a whole-buffer view", () => {
    const u = new Uint8Array([1, 2, 3, 4]);
    expect([...new Uint8Array(toArrayBuffer(u))]).toEqual([1, 2, 3, 4]);
  });

  // The case the cast got wrong. A subarray shares its parent's buffer, so casting the VIEW to an
  // ArrayBuffer hands the importer every byte of the parent — a different key, imported without error.
  it("copies a subarray rather than exposing the parent buffer", () => {
    const parent = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const view = parent.subarray(2, 6);
    expect(view.byteOffset).toBe(2);

    const ab = toArrayBuffer(view);
    expect(ab.byteLength).toBe(4);
    expect([...new Uint8Array(ab)]).toEqual([1, 2, 3, 4]);

    // And what the cast would have produced instead, for contrast:
    expect(view.buffer.byteLength).toBe(8);
  });

  it("does not alias the parent, so a later write cannot change an imported key", () => {
    const parent = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const ab = toArrayBuffer(parent.subarray(0, 3));
    parent[0] = 99;
    expect(new Uint8Array(ab)[0]).toBe(1);
  });

  it("handles an empty view", () => {
    expect(toArrayBuffer(new Uint8Array(0)).byteLength).toBe(0);
  });
});
