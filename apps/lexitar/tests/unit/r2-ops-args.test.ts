import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseR2OpsArgs, usage } from "../../scripts/r2-ops-args";

describe("parseR2OpsArgs", () => {
  const savedMode = process.env.INFERENCE_MODE;

  beforeEach(() => {
    delete process.env.INFERENCE_MODE;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.INFERENCE_MODE;
    else process.env.INFERENCE_MODE = savedMode;
  });

  it("parses --refresh-finding with --client", () => {
    const out = parseR2OpsArgs(["--refresh-finding", "--client", "alex"]);
    expect(out).toMatchObject({ op: "refresh-finding", client: "alex", dryRun: false, force: false, mode: "prod" });
  });

  it("parses --refresh-ranges with --marker", () => {
    const out = parseR2OpsArgs(["--refresh-ranges", "--client", "alex", "--marker", "TSH"]);
    expect(out).toMatchObject({ op: "refresh-ranges", marker: "TSH", allMarkers: false });
  });

  it("requires --marker or --all-markers for --refresh-ranges", () => {
    expect(() => parseR2OpsArgs(["--refresh-ranges", "--client", "alex"])).toThrow(
      /--refresh-ranges needs --marker <name> or --all-markers/,
    );
  });

  it("accepts --all-markers in place of --marker", () => {
    const out = parseR2OpsArgs(["--refresh-ranges", "--client", "alex", "--all-markers"]);
    expect(out.allMarkers).toBe(true);
    expect(out.marker).toBeUndefined();
  });

  it("requires --client for every op except --reconcile", () => {
    expect(() => parseR2OpsArgs(["--refresh-finding"])).toThrow(/--client is required for --refresh-finding/);
  });

  it("allows --reconcile with no --client", () => {
    const out = parseR2OpsArgs(["--reconcile"]);
    expect(out).toMatchObject({ op: "reconcile", client: undefined });
  });

  it("parses --sync-treatment-attachments with an optional trailing name", () => {
    const bare = parseR2OpsArgs(["--sync-treatment-attachments", "--client", "alex"]);
    expect(bare.name).toBeUndefined();

    const named = parseR2OpsArgs(["--sync-treatment-attachments", "Tirzepatide", "--client", "alex"]);
    expect(named.name).toBe("Tirzepatide");

    // a following flag (not a bare name) must not be swallowed as the name.
    const followedByFlag = parseR2OpsArgs(["--sync-treatment-attachments", "--client", "alex", "--dry-run"]);
    expect(followedByFlag.name).toBeUndefined();
    expect(followedByFlag.dryRun).toBe(true);
  });

  it("parses --dry-run, --force, --store, and --mode", () => {
    const out = parseR2OpsArgs([
      "--refresh-finding",
      "--client",
      "alex",
      "--dry-run",
      "--force",
      "--store",
      "dev",
      "--mode",
      "dev",
    ]);
    expect(out).toMatchObject({ dryRun: true, force: true, store: "dev", mode: "dev" });
  });

  it("rejects more than one op", () => {
    expect(() => parseR2OpsArgs(["--refresh-finding", "--reconcile"])).toThrow(
      /only one op allowed, got --refresh-finding and --reconcile/,
    );
  });

  it("requires exactly one op", () => {
    expect(() => parseR2OpsArgs([])).toThrow(/no op given/);
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseR2OpsArgs(["--refresh-finding", "--client", "alex", "--bogus"])).toThrow(
      /unrecognized argument "--bogus"/,
    );
  });

  it("every thrown usage error includes the usage text", () => {
    expect(() => parseR2OpsArgs([])).toThrow(usage());
  });
});
