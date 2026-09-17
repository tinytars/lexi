// Dedicated parser for the eight R2/D1-native ops (scripts/commands/r2-ops.ts). ingest-args.ts's
// 42-flag Args/parseArgs is dead code in this repo (no caller besides its own unit test — ingest.ts
// itself was excluded from the plover-code -> lexi port) and pulls in flags none of these eight ops
// use, so this covers only what they need rather than reusing it.
import { resolveMode } from "./inference-config";
import type { InferenceMode } from "../src/lib/types";

export type R2Op =
  | "refresh-finding"
  | "refresh-ranges"
  | "refresh-marker-groups"
  | "process-pending"
  | "reconcile"
  | "sync-treatment-attachments"
  | "treatment-groups-backfill"
  | "treatment-photo-extract";

const OPS: R2Op[] = [
  "refresh-finding",
  "refresh-ranges",
  "refresh-marker-groups",
  "process-pending",
  "reconcile",
  "sync-treatment-attachments",
  "treatment-groups-backfill",
  "treatment-photo-extract",
];

export interface R2OpsArgs {
  op: R2Op;
  client?: string;
  store?: string;
  mode: InferenceMode;
  dryRun: boolean;
  force: boolean;
  marker?: string;
  allMarkers: boolean;
  name?: string; // sync-treatment-attachments's optional treatment-name filter, treatment-photo-extract's required one
  rowId?: string; // treatment-photo-extract's optional --id, to disambiguate same-named rows
  keys?: string[]; // treatment-photo-extract's repeatable --key <raw-object-key>
}

export function usage(): string {
  return [
    "Usage: tsx scripts/r2-ops-cli.ts --<op> --client <id> [options]",
    "",
    "Ops (exactly one required):",
    "  --refresh-finding                     regen this client's Finding",
    "  --refresh-ranges                       regen personalized ranges (needs --marker <name> or --all-markers)",
    "  --refresh-marker-groups                regen marker groupings",
    "  --process-pending                      fold this client's queued uploads",
    "  --reconcile                            process-pending; omit --client to run every deployed vault",
    "  --sync-treatment-attachments [name]    repair treatment<->attachment links (optionally one treatment)",
    "  --treatment-groups-backfill            regenerate stale treatment-derived Finding leaf nodes",
    "  --treatment-photo-extract              extract label fields from photos (needs --name and --key)",
    "",
    "Options:",
    "  --client <id>       vault id (required for every op except --reconcile)",
    "  --store <prefix>    R2/D1 store prefix (default: this worktree's wrangler.jsonc target)",
    "  --mode dev|prod     inference model tier (default: prod)",
    "  --dry-run           mutate in memory, never push to R2",
    "  --force             regenerate even when nothing looks stale (refresh-finding/-ranges/-marker-groups)",
    "  --marker <name>     refresh-ranges: one marker",
    "  --all-markers       refresh-ranges: every marker with readings",
    "  --name <name>       treatment-photo-extract: treatment name to patch (required)",
    "  --id <row-id>       treatment-photo-extract: disambiguate rows sharing --name",
    "  --key <raw-key>     treatment-photo-extract: one photo's raw object key (repeatable, at least one required)",
  ].join("\n");
}

class UsageError extends Error {}

export function parseR2OpsArgs(argv: string[]): R2OpsArgs {
  let op: R2Op | undefined;
  let client: string | undefined;
  let store: string | undefined;
  let modeFlag: string | undefined;
  let dryRun = false;
  let force = false;
  let marker: string | undefined;
  let allMarkers = false;
  let name: string | undefined;
  let rowId: string | undefined;
  let keys: string[] | undefined;

  const fail = (msg: string): never => {
    throw new UsageError(`${msg}\n\n${usage()}`);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const asOp = a.startsWith("--") ? (a.slice(2) as R2Op) : undefined;
    if (asOp && (OPS as string[]).includes(asOp)) {
      if (op) fail(`only one op allowed, got --${op} and ${a}`);
      op = asOp;
      if (op === "sync-treatment-attachments" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        name = argv[++i];
      }
      continue;
    }
    switch (a) {
      case "--client":
        client = argv[++i];
        break;
      case "--store":
        store = argv[++i];
        break;
      case "--mode":
        modeFlag = argv[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--marker":
        marker = argv[++i];
        break;
      case "--all-markers":
        allMarkers = true;
        break;
      case "--name":
        name = argv[++i];
        break;
      case "--id":
        rowId = argv[++i];
        break;
      case "--key":
        (keys ??= []).push(argv[++i]);
        break;
      default:
        fail(`unrecognized argument "${a}"`);
    }
  }

  if (!op) fail(`no op given — pick one of ${OPS.map((o) => `--${o}`).join(", ")}`);
  if (!client && op !== "reconcile") fail(`--client is required for --${op}`);
  if (op === "refresh-ranges" && !marker && !allMarkers) fail("--refresh-ranges needs --marker <name> or --all-markers");
  if (op === "treatment-photo-extract") {
    if (!name) fail("--treatment-photo-extract needs --name \"<treatment name>\"");
    if (!keys || keys.length === 0) fail("--treatment-photo-extract needs at least one --key <raw-key>");
  }

  return { op: op!, client, store, mode: resolveMode(modeFlag), dryRun, force, marker, allMarkers, name, rowId, keys };
}
