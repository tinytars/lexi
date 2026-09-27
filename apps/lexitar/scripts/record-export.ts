// `npm run record:export` — a complete local copy of one health record: the structured data and every
// stored document, decrypted, under the credential of the principal the record belongs to.
//
// Small, because a record IS one encrypted object plus the files it references: one decryption and N
// downloads, no report to assemble. The design work is in two places instead.
//
// WHERE IT LANDS is export-dir.ts's problem, and it refuses at run time rather than trusting an
// ignore rule. WHAT IT PRINTS is this file's: stdout is deliberately contents-free — sha8, kind,
// bytes, sealed-or-not, opened-or-not — because the common caller is an agent whose transcript should
// not become a second copy of the record. The readable material is on disk, named in manifest.json,
// and the last line printed is the command that removes it.
//
// Documents are driven from the RAW ROUTE'S OWN LISTING (`?files=1`), not from `client.sources[]`.
// `SourceRecord.file` is a repo-relative path from the CLI-ingest era, not a raw key — the only
// producer of a raw key is `<sha8>-<safeName>` (attachment-store.ts:29) — so the listing is the
// authoritative set and the record is what annotates it. An object the record no longer references
// still belongs to the patient and is still exported, marked `referenced: false`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authedFetch, cliCredentials, login, openVault, type Session } from "./api-session";
import { exportRoot, purge, runDir } from "./export-dir";
import { isMain } from "./is-main";
import { resolveClientKey } from "./vault-ops";
import { normalizeClientId } from "../src/lib/client-id";
import { isSealed, openRaw, RawKeyError } from "../src/lib/raw-cipher";
import type { Client, Vault } from "../src/lib/types";

export interface DocEntry {
  /** The key under `raw/{clientId}/`, which is also what the text sidecar is keyed by. */
  file: string;
  sha8: string | null;
  originalName: string;
  kind: string;
  /** False for an object in the store that the record itself no longer mentions. */
  referenced: boolean;
}

export interface FetchOutcome {
  bytes: number;
  sealed: boolean;
  /** `undefined` when it opened; the reason it did not otherwise. */
  unreadable?: string;
  transcriptChars?: number;
}

export interface Manifest {
  exportedAt: string;
  baseUrl: string;
  accountId: string;
  vaultId: string;
  blobId: string;
  clientKey: string;
  rotationPending: boolean;
  documents: (DocEntry & FetchOutcome & { savedAs: string; transcriptSavedAs?: string })[];
}

const sha8Of = (file: string): string | null => /^([0-9a-f]{8})-/.exec(file)?.[1] ?? null;

/**
 * Every attachment anywhere in the record, by a shape test rather than by the seven fields that hold
 * one: an eighth would otherwise go unnamed in the manifest and be reported as unreferenced.
 */
export function collectAttachments(client: Client): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.key === "string" && typeof o.name === "string" && typeof o.mediaType === "string") found.set(o.key, o.name);
    Object.values(o).forEach(walk);
  };
  walk(client);
  return found;
}

/** What to fetch, and what the record knows about each one. Pure: the listing plus the record in. */
export function planDocuments(client: Client, listed: string[]): DocEntry[] {
  const attachments = collectAttachments(client);
  const bySha8 = new Map<string, { originalName: string; kind: string }>();
  for (const s of client.sources ?? [])
    bySha8.set(s.sha256.slice(0, 8), {
      originalName: s.originalName,
      kind: s.kind,
    });
  for (const p of client.pendingUploads ?? [])
    bySha8.set(p.sha256.slice(0, 8), {
      originalName: p.originalName,
      kind: "pending",
    });

  return listed
    .filter((file) => file && !file.endsWith("/"))
    .sort()
    .map((file) => {
      const sha8 = sha8Of(file);
      const known = sha8 ? bySha8.get(sha8) : undefined;
      const attachmentName = attachments.get(file);
      return {
        file,
        sha8,
        originalName: known?.originalName ?? attachmentName ?? file.replace(/^[0-9a-f]{8}-/, ""),
        kind: known?.kind ?? (attachmentName ? "attachment" : "unknown"),
        referenced: !!known || !!attachmentName,
      };
    });
}

/** One on-disk name per entry, disambiguated by sha8 when two documents share an original name. */
export function outputNames(entries: DocEntry[]): Map<string, string> {
  const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "document";
  const bases = entries.map((e) => ({
    file: e.file,
    sha8: e.sha8,
    base: safe(e.originalName),
  }));
  const counts = new Map<string, number>();
  for (const { base } of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return new Map(bases.map(({ file, sha8, base }) => [file, counts.get(base)! > 1 ? `${sha8 ?? "nosha"}-${base}` : base]));
}

/**
 * The run as stdout should describe it: counts, hashes and outcomes, no contents.
 *
 * Asserted by the suite to contain no display name and no original file name — the machine-checked
 * form of "the agent's transcript must not become a second copy of the record".
 */
export function summaryLines(m: Manifest): string[] {
  const total = m.documents.reduce((n, d) => n + d.bytes, 0);
  const unreadable = m.documents.filter((d) => d.unreadable).length;
  const lines = [
    `account ${m.accountId} · vault ${m.vaultId} · blob ${m.blobId} · client ${m.clientKey}`,
    `origin ${m.baseUrl}`,
    ...(m.rotationPending ? ["rotation_pending: a support envelope expired and this vault wants re-keying"] : []),
    `${m.documents.length} documents · ${total} bytes · ${unreadable} unreadable`,
  ];
  for (const d of m.documents) {
    const state = d.unreadable ? `unreadable(${d.unreadable})` : "ok";
    const text = d.transcriptChars === undefined ? "no transcript" : `transcript ${d.transcriptChars} chars`;
    lines.push(
      `  ${d.sha8 ?? "--------"} · ${d.kind}${d.referenced ? "" : " · unreferenced"} · ${d.bytes} bytes · ${d.sealed ? "sealed" : "plaintext"} · ${state} · ${text}`,
    );
  }
  return lines;
}

async function listRawFiles(session: Session, clientId: string): Promise<string[]> {
  const res = await authedFetch(session, `/api/raw/${clientId}?files=1`);
  if (!res.ok) throw new Error(`cannot list documents for ${clientId} (${res.status})`);
  return ((await res.json()) as { files: string[] }).files;
}

/** The cached extraction, opened under the DOCUMENT's content key — the sidecar is sealed with it. */
async function fetchTranscript(
  session: Session,
  clientId: string,
  file: string,
  key: string | undefined,
): Promise<string | null> {
  const res = await authedFetch(session, `/api/document-extract?id=${clientId}&key=${encodeURIComponent(file)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`cannot read the transcript of ${file} (${res.status})`);
  const stored = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder().decode(await openRaw(stored, file, key));
}

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    client: value("client"),
    dryRun: flag("dry-run"),
    stdout: flag("stdout"),
    purge: flag("purge"),
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  if (args.purge) {
    const removed = purge();
    out(removed.length ? `removed ${removed.length} export(s) from ${exportRoot()}` : `nothing to remove in ${exportRoot()}`);
    return;
  }

  const creds = cliCredentials();
  const session = await login(creds);
  const { vault, accountId, vaultId, blobId, rotationPending } = await openVault(session);
  const clientKey = args.client ?? resolveClientKey(vault, blobId);
  const client = vault.clients[clientKey];
  if (!client) throw new Error(`no client "${clientKey}" in this vault`);
  const clientId = normalizeClientId(clientKey);
  const keyring = (vault as Vault).rawKeys?.[clientId] ?? {};

  const entries = planDocuments(client, await listRawFiles(session, clientId));
  const names = outputNames(entries);

  if (args.dryRun) {
    out(`${entries.length} documents would be fetched for ${clientId} from ${creds.baseUrl}; nothing written`);
    for (const e of entries) out(`  ${e.sha8 ?? "--------"} · ${e.kind}${e.referenced ? "" : " · unreferenced"}`);
    return;
  }

  const dir = runDir(blobId);
  mkdirSync(join(dir, "documents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "transcripts"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "record.json"), JSON.stringify(client, null, 2), {
    mode: 0o600,
  });

  const documents: Manifest["documents"] = [];
  for (const e of entries) {
    const savedAs = join("documents", names.get(e.file)!);
    const res = await authedFetch(session, `/api/raw/${clientId}/${encodeURIComponent(e.file)}`);
    if (!res.ok) {
      documents.push({
        ...e,
        savedAs,
        bytes: 0,
        sealed: false,
        unreadable: `http ${res.status}`,
      });
      continue;
    }
    const stored = new Uint8Array(await res.arrayBuffer());
    const sealed = isSealed(stored);
    try {
      writeFileSync(join(dir, savedAs), await openRaw(stored, e.file, keyring[e.file]), { mode: 0o600 });
    } catch (err) {
      // Never silently skipped: a partial export that looks complete is worse than one that says
      // which document it could not open.
      const reason =
        err instanceof RawKeyError
          ? err.reason === "missing"
            ? "missing content key"
            : "wrong content key"
          : (err as Error).message;
      documents.push({
        ...e,
        savedAs,
        bytes: stored.length,
        sealed,
        unreadable: reason,
      });
      continue;
    }
    const text = await fetchTranscript(session, clientId, e.file, keyring[e.file]).catch((err: Error) => `!${err.message}`);
    const entry: Manifest["documents"][number] = {
      ...e,
      savedAs,
      bytes: stored.length,
      sealed,
    };
    if (typeof text === "string" && !text.startsWith("!")) {
      entry.transcriptSavedAs = join("transcripts", `${names.get(e.file)!}.json`);
      entry.transcriptChars = text.length;
      writeFileSync(join(dir, entry.transcriptSavedAs), text, { mode: 0o600 });
    }
    documents.push(entry);
  }

  const manifest: Manifest = {
    exportedAt: new Date().toISOString(),
    baseUrl: creds.baseUrl,
    accountId,
    vaultId,
    blobId,
    clientKey,
    rotationPending,
    documents,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });

  summaryLines(manifest).forEach(out);
  if (args.stdout) out(JSON.stringify(client, null, 2));
  out(`exported to ${dir}`);
  out(`remove it with: rm -rf ${dir}`);
}

if (isMain(import.meta.url)) {
  main().catch((e: Error) => {
    process.stderr.write(`record:export failed: ${e.message}\n`);
    process.exit(1);
  });
}
