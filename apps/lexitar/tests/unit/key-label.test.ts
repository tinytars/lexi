// An R2 key names a person, so what a script PRINTS is a disclosure decision.
//
// Two things are pinned here, and the second is the one that will actually catch something. The first
// is what the renderer does. The second is that the scripts the hosted workflows run route their key
// output through it at all — the defect this fixes was not a wrong label but a bare `${k}`, and the
// way it comes back is somebody adding a sixth print statement in the obvious style of the five that
// were already there. So the drift guard reads the source and refuses a bare key-bearing identifier
// inside a `write(...)`, the same technique erasure-completeness.test.ts uses on storeKey call sites.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KEYS_HINT, keyLabel, nsLabel, showsKeys } from "../../scripts/key-label";

const ROOT = resolve(__dirname, "../..");
const RAW = "prod/raw/0b8c/labs-elizabeth-2026-03.pdf";

describe("a key is rendered without the person it names", () => {
  it("keeps the store and the key class and nothing else", () => {
    expect(keyLabel(RAW, false)).toMatch(/^prod\/raw\/#[0-9a-f]{8}$/);
  });

  it("drops the namespace and the filename, which are the identifying halves", () => {
    const label = keyLabel(RAW, false);
    expect(label).not.toContain("0b8c");
    expect(label).not.toContain("elizabeth");
    expect(label).not.toContain(".pdf");
  });

  it("renders a flat per-vault key by its class, keeping the slug out of it", () => {
    expect(keyLabel("prod/data-0b8c.enc", false)).toMatch(/^prod\/data-#[0-9a-f]{8}$/);
    expect(keyLabel("prod/chat-0b8c.enc", false)).toMatch(/^prod\/chat-#[0-9a-f]{8}$/);
    expect(keyLabel("prod/data-0b8c.enc", false)).not.toContain("0b8c");
  });

  it("covers the regen-log segments the same way", () => {
    const label = keyLabel("dev/regen-log/0b8c/2026-10-20T11-00-00Z-a1b2c3d4.enc", false);
    expect(label).toBe(`dev/regen-log/#${keyLabel("dev/regen-log/0b8c/2026-10-20T11-00-00Z-a1b2c3d4.enc", false).slice(-8)}`);
    expect(label).not.toContain("0b8c");
  });

  it("has nothing safe to keep in a bare namespace, so keeps nothing", () => {
    expect(nsLabel("Elizabeth Stangle", false)).toMatch(/^#[0-9a-f]{8}$/);
    expect(nsLabel("Elizabeth Stangle", false)).not.toMatch(/eliz/i);
  });

  it("is stable, so a redacted alarm and a local --keys run name the same object", () => {
    expect(keyLabel(RAW, false)).toBe(keyLabel(RAW, false));
    expect(keyLabel(RAW, false)).not.toBe(keyLabel("prod/raw/0b8c/other.pdf", false));
  });

  it("prints the real key only when the invocation asked for one", () => {
    expect(keyLabel(RAW, true)).toBe(RAW);
    expect(nsLabel("Elizabeth Stangle", true)).toBe("Elizabeth Stangle");
    expect(showsKeys([])).toBe(false);
    expect(showsKeys(["tsx", "x.ts", "--keys"])).toBe(true);
  });

  it("defaults to redacted, because the cost of the two mistakes is not symmetric", () => {
    // Forgetting --keys costs a re-run of a read-only report. The opposite default costs a
    // disclosure on a public run page that cannot be withdrawn.
    expect(keyLabel(RAW)).not.toContain("elizabeth");
  });
});

describe("the scripts the hosted workflows run never print a key themselves", () => {
  // `snapshot` runs vault-snapshot.ts; `ops` runs orphan-sweep.ts. Both are workflow_dispatch on a
  // PUBLIC repository, so their run pages are world-readable.
  const FILES = ["scripts/vault-snapshot.ts", "scripts/orphan-sweep.ts"];
  // Identifiers these two files hold a key or a namespace in. A renderer call reads as
  // `keyLabel(k)`, never as a bare `${k}`.
  const BARE = new Set(["k", "key", "o.key", "c", "ns", "namespace", "obj.key"]);

  const writes = (src: string): string[] => src.split("\n").filter((l) => /process\.(stdout|stderr)\.write\(/.test(l));

  it.each(FILES)("%s interpolates no bare key into anything it writes", (file) => {
    for (const line of writes(readFileSync(resolve(ROOT, file), "utf8"))) {
      for (const [, expr] of line.matchAll(/\$\{([^}]+)\}/g)) {
        expect(BARE.has(expr.trim()), `${file} writes a bare \${${expr.trim()}} — wrap it in keyLabel()/nsLabel()`).toBe(false);
      }
    }
  });

  it("finds the renderer at the call sites, so the sweep above cannot pass by finding nothing", () => {
    const calls = FILES.map((f) => readFileSync(resolve(ROOT, f), "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => /process\.(stdout|stderr)\.write\(/.test(l) && /(keyLabel|nsLabel)\(/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("tells the operator what was withheld rather than looking complete", () => {
    for (const f of FILES) expect(readFileSync(resolve(ROOT, f), "utf8")).toContain("KEYS_HINT");
    expect(KEYS_HINT).toMatch(/--keys/);
  });
});
