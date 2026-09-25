import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestDir } from "../support/miniflare";

// The flake this pins: a streaming route's writes were still landing in the Node host's bucket
// directory when the file's afterAll ran, and rmSync dies with ENOTEMPTY when an entry appears
// between its readdir and its rmdir. All 3309 tests had passed and only teardown failed, which is
// the shape that blocks a merge while reporting no defect.
describe("removeTestDir", () => {
  it("removes a directory that is still being written into", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexi-teardown-"));

    // Queued, deliberately not awaited: these writes sit in libuv's threadpool and keep landing
    // while the removal walks the directory, which is the race itself. A write that loses the race
    // fails with ENOENT, which is the expected end of it.
    const inFlight = Array.from({ length: 2000 }, (_, i) =>
      writeFile(join(dir, `object-${i}`), "x").catch(() => {}),
    );

    expect(() => removeTestDir(dir)).not.toThrow();

    await Promise.all(inFlight);
    removeTestDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
