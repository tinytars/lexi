// The guard that decides where readable PHI may land. It is a run-time refusal rather than a
// .gitignore entry for two reasons this suite pins: the repo is public, and its ignore file
// re-includes records/** — so the one directory an operator would reach for is the one git would
// happily stage.
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutsideRepos, exportRoot, purge, runDir, runStamp } from "../../scripts/export-dir";

const REPO_FILE = fileURLToPath(import.meta.url);
const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lexi-export-test-"));
  tmps.push(d);
  return d;
};

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("assertOutsideRepos", () => {
  // The tree it names is whichever one this suite is running in — a worktree here, the checkout on a
  // CI runner. Asserting a directory NAME pinned the developer's worktree slug and failed on the
  // runner, which was the guard working and the test being wrong about what it had proved.
  it("refuses a path inside this git work tree, naming the tree", () => {
    const tree = resolve(REPO_FILE, "../../../../..");
    expect(() => assertOutsideRepos(resolve(REPO_FILE, "../../../exports"))).toThrow(`git work tree at ${tree}`);
  });

  it("refuses records/, which .gitignore deliberately re-includes", () => {
    expect(() => assertOutsideRepos(resolve(REPO_FILE, "../../../records/out"))).toThrow(/records/);
  });

  it("accepts a directory with no git ancestor", () => {
    expect(() => assertOutsideRepos(join(tmp(), "run"))).not.toThrow();
  });
});

describe("exportRoot", () => {
  it("honours XDG_STATE_HOME so the destination is per-user state, not a repo or a temp dir", () => {
    vi.stubEnv("LEXI_EXPORT_DIR", "");
    vi.stubEnv("XDG_STATE_HOME", "/xdg");
    expect(exportRoot()).toBe("/xdg/lexitar/exports");
  });

  it("lets LEXI_EXPORT_DIR override it", () => {
    vi.stubEnv("LEXI_EXPORT_DIR", "/elsewhere/out");
    expect(exportRoot()).toBe("/elsewhere/out");
  });
});

describe("runDir", () => {
  it("creates a 0700 directory stamped with the vault and the time", () => {
    vi.stubEnv("LEXI_EXPORT_DIR", tmp());
    const dir = runDir("blob-1", new Date("2026-09-27T05:06:07.890Z"));
    expect(dir.endsWith("blob-1-20260927T050607Z")).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses to create one inside a git work tree", () => {
    const root = tmp();
    writeFileSync(join(root, ".git"), "gitdir: elsewhere");
    vi.stubEnv("LEXI_EXPORT_DIR", join(root, "exports"));
    expect(() => runDir("blob-1")).toThrow(/git work tree/);
  });
});

describe("purge", () => {
  it("removes every export, and says which", () => {
    const root = tmp();
    vi.stubEnv("LEXI_EXPORT_DIR", root);
    mkdirSync(join(root, "blob-1-20260101T000000Z"), { recursive: true });
    writeFileSync(join(root, "blob-1-20260101T000000Z", "record.json"), "{}");
    expect(purge()).toHaveLength(1);
    expect(existsSync(join(root, "blob-1-20260101T000000Z"))).toBe(false);
  });

  it("keeps an export younger than the cutoff", () => {
    const root = tmp();
    vi.stubEnv("LEXI_EXPORT_DIR", root);
    mkdirSync(join(root, "blob-1-20260101T000000Z"), { recursive: true });
    expect(purge(60_000)).toEqual([]);
  });

  it("is a no-op when nothing was ever exported", () => {
    vi.stubEnv("LEXI_EXPORT_DIR", join(tmp(), "never-created"));
    expect(purge()).toEqual([]);
  });
});

describe("runStamp", () => {
  it("is filename-safe and sorts chronologically", () => {
    expect(runStamp(new Date("2026-09-27T05:06:07.890Z"))).toBe("20260927T050607Z");
  });
});
