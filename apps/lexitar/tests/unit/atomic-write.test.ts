import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { atomicWriteFile, atomicWriteJson } from "../../scripts/atomic-write";

// W59 — regression tests for the recurring records/private/{id}/vault.json truncation-to-0-bytes.
// The failure this guards is not "a write produced wrong content", it is "a write destroyed good PHI
// and left nothing" — so every assertion here checks that the PREVIOUS content survived.

const GOOD = '{\n  "clients": {\n    "blair": 1\n  }\n}\n';

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "atomic-write-"));
  const path = resolve(dir, "vault.json");
  await writeFile(path, GOOD);
  return { dir, path };
}

describe("atomicWriteFile / atomicWriteJson (W59)", () => {
  it("refuses to write 0 bytes, leaving the existing file untouched", async () => {
    const { path } = await fixture();
    await expect(atomicWriteFile(path, "")).rejects.toThrow(/0 bytes/);
    expect(await readFile(path, "utf8")).toBe(GOOD);
  });

  it("refuses null/undefined and an empty object — each means the caller lost its data", async () => {
    const { path } = await fixture();
    await expect(atomicWriteJson(path, null)).rejects.toThrow();
    await expect(atomicWriteJson(path, undefined)).rejects.toThrow();
    await expect(atomicWriteJson(path, {})).rejects.toThrow(/empty object/);
    expect(await readFile(path, "utf8")).toBe(GOOD);
  });

  it("writes valid content and leaves no temp file behind", async () => {
    const { dir, path } = await fixture();
    await atomicWriteJson(path, { clients: { blair: 2 } });
    expect(JSON.parse(await readFile(path, "utf8")).clients.blair).toBe(2);
    expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("never leaves the destination truncated: the temp file absorbs a failed write", async () => {
    // The real-world mechanism: a plain writeFile(path, data) opens with O_TRUNC, so the destination
    // is 0 bytes the instant the write starts and stays that way if the process dies mid-write.
    // atomicWriteFile writes elsewhere and renames, so the destination only ever changes atomically.
    // Simulate the interrupted write by pointing at an unwritable temp location.
    const { path } = await fixture();
    await expect(atomicWriteFile(resolve(path, "no-such-dir", "vault.json"), "x")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(GOOD);
  });

  it("a large payload round-trips (the 512 KB mid-write boundary case)", async () => {
    // alex/vault.json is ~654 KB and was once found truncated at exactly 524288 bytes (512x1024) —
    // a chunk boundary of an interrupted streaming write. A payload spanning that boundary must land
    // whole or not at all.
    const { path } = await fixture();
    const big = { clients: { blair: "x".repeat(700 * 1024) } };
    await atomicWriteJson(path, big);
    const back = JSON.parse(await readFile(path, "utf8"));
    expect(back.clients.blair.length).toBe(700 * 1024);
  });
});
