// `npm run record:export` — a complete local copy of one health record: the structured data and every
// stored document, decrypted, under the credential of a principal entitled to read it. Two are: the
// record's own owner (no flags, the original behaviour), and the export principal reading a record a
// patient has approved it for (`--patient`, `--url`, `--all`, `--list`, `--request`), which is a
// disclosure and is written to that patient's own access screen on every open.
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
import {
  authedFetch,
  cliCredentials,
  listGrantedOwners,
  login,
  openGrantedVault,
  openVault,
  requestAccess,
  supportCredentials,
  withPassword,
  type GrantedOwner,
  type OpenVault,
  type Session,
} from "./api-session";
import { exportRoot, purge, runDir } from "./export-dir";
import { isMain } from "./is-main";
import { clientKeyFromUrl, findClientKey, resolveOwner } from "./resolve-owner";
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

/**
 * The document namespace, or nothing.
 *
 * A 404 is the answer for a record that has no documents yet, because `mayRead` excludes an
 * `unclaimed` namespace and the route deliberately returns 404 rather than 403 so a refusal cannot
 * confirm an object exists (`functions/api/raw/[[path]].ts:87`). The three readings — empty, orphaned,
 * not yours — are one status and one body to a client, so this reports zero documents and says the
 * ambiguity out loud rather than inventing a distinction it cannot make.
 */
/**
 * How much text the extraction found, which is the sidecar's own `chars` and NOT the length of the
 * JSON that wraps it — reporting the wrapper made a 59-character note read as 223 characters of text.
 */
export function extractedChars(sidecar: string): number {
  const parsed = JSON.parse(sidecar) as { chars?: unknown; text?: unknown };
  if (typeof parsed.chars === "number") return parsed.chars;
  return typeof parsed.text === "string" ? parsed.text.length : 0;
}

async function listRawFiles(session: Session, clientId: string): Promise<{ files: string[]; note?: string }> {
  const res = await authedFetch(session, `/api/raw/${clientId}?files=1`);
  if (res.status === 404) {
    return { files: [], note: `no documents under ${clientId} — the namespace is empty, or it is not this account's` };
  }
  if (!res.ok) throw new Error(`cannot list documents for ${clientId} (${res.status})`);
  return { files: ((await res.json()) as { files: string[] }).files };
}

/**
 * The cached extraction, opened under the DOCUMENT's content key — `document-extract.ts:190` seals
 * the sidecar with the same `rawKey` it opened the original with.
 */
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
    // `--patient` takes an ACCOUNT ID, not an address: the only endpoint that hands this principal an
    // email is the one listing its not-yet-approved requests, so an address would resolve for a patient
    // who has not approved anything and stop resolving the moment they do. `--list` prints the ids, and
    // `--url` takes what the operator actually has in hand — see scripts/resolve-owner.ts.
    patient: value("patient"),
    url: value("url"),
    probe: flag("probe"),
    all: flag("all"),
    list: flag("list"),
    request: value("request"),
  };
}

type Args = ReturnType<typeof parseArgs>;

/** Exported for the tests: the flag handling and the two principals' paths are the behaviour under test. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  if (args.purge) {
    const removed = purge();
    out(removed.length ? `removed ${removed.length} export(s) from ${exportRoot()}` : `nothing to remove in ${exportRoot()}`);
    return;
  }
  if (args.list || args.request || args.all || args.patient || args.url) return supportMain(args, out);

  const session = await login(await withPassword(cliCredentials()));
  await exportOne(session, await openVault(session), args, out);
}

/**
 * Everything from an open vault to the files on disk, identical whoever opened it — the owner path and
 * the granted path differ only in which principal signed in and whose envelope unwrapped the key.
 */
async function exportOne(session: Session, open: OpenVault, args: Args, out: (s: string) => void): Promise<void> {
  const { vault, accountId, vaultId, blobId, rotationPending } = open;
  const clientKey = args.client ?? resolveClientKey(vault, blobId);
  const client = vault.clients[clientKey];
  if (!client) throw new Error(`no client "${clientKey}" in this vault`);
  const clientId = normalizeClientId(clientKey);
  const keyring = (vault as Vault).rawKeys?.[clientId] ?? {};

  const { files, note } = await listRawFiles(session, clientId);
  if (note) out(note);
  const entries = planDocuments(client, files);
  const names = outputNames(entries);

  if (args.dryRun) {
    out(`${entries.length} documents would be fetched for ${clientId} from ${session.baseUrl}; nothing written`);
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
      entry.transcriptChars = extractedChars(text);
      writeFileSync(join(dir, entry.transcriptSavedAs), text, { mode: 0o600 });
    }
    documents.push(entry);
  }

  const manifest: Manifest = {
    exportedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
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

/**
 * The export principal's paths. Nothing here reaches a record that a patient has not approved: every
 * target comes from `listGrantedOwners`, which the server has already filtered to live grants — see
 * `openGrantedVault`'s header for what opening a lapsed one would cost that patient.
 */
async function supportMain(args: Args, out: (s: string) => void): Promise<void> {
  const say = (s: string) => process.stderr.write(`${s}\n`);
  if (args.url && args.patient) throw new Error("--url and --patient name the same thing two ways — pass one");
  const session = await login(supportCredentials());

  if (args.request) {
    const { linkId, status } = await requestAccess(session, args.request);
    if (status === "invited") {
      say(`asked ${args.request} for access (link ${linkId}) — nothing is readable until they approve it`);
      say("they open the app, find this tool under Access, and approve it with 7 days in the dropdown");
      return;
    }
    // `status` is whatever a pre-existing link already said, and an approval whose window has elapsed
    // is still `active` — so this cannot be reported as success. The order matters: revoking first
    // deletes the stale envelope without setting `rotation_pending`, and re-requesting first does not.
    say(`${args.request} already has a link to this tool (${linkId}, ${status}), which is not proof that it is live`);
    say("run --list: if their account id is not in it, that approval has lapsed, and the order is");
    say("  1. they press Revoke on this tool's entry in their Access panel");
    say("  2. re-run --request, and they approve the fresh one with 7 days");
    say("re-approving without revoking first re-keys their whole record at their next sign-in, for nothing");
    return;
  }

  const owners = await listGrantedOwners(session);
  if (args.list) {
    out(owners.length ? `${owners.length} record(s) approved for export` : "no records are approved for export");
    for (const o of owners) out(`  ${o.ownerAccountId} · until ${o.expiresAt ?? "no expiry"}`);
    return;
  }

  if (args.url) return exportByUrl(session, args, owners, out, say);

  if (!args.all) {
    // Refused here rather than by the server, because asking the server is itself the harm: opening a
    // lapsed grant is what re-keys that patient's record.
    if (!owners.some((o) => o.ownerAccountId === args.patient)) {
      throw new Error(
        `${args.patient} has not approved this tool, or the approval has lapsed — run ` +
          "--request <their email>, or --list to see what is live",
      );
    }
    await exportOne(session, await openGrantedVault(session, args.patient!), args, out);
    return;
  }

  if (!owners.length) {
    say("no records are approved for export — run --request <their email> for each person");
    return;
  }
  let failed = 0;
  for (const { ownerAccountId } of owners) {
    try {
      await exportOne(session, await openGrantedVault(session, ownerAccountId), args, out);
    } catch (e) {
      // One unreadable record must not cost the rest of the sweep — but it is still a failure, so the
      // exit status says so rather than an operator having to read every line of an unattended run.
      failed += 1;
      say(`skipped ${ownerAccountId}: ${(e as Error).message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${owners.length} record(s) could not be exported`);
}

/**
 * `--url`: what the operator is looking at names a client key inside one record, not an account, so the
 * ladder in scripts/resolve-owner.ts turns it into an owner without opening anything. Only `--probe`
 * opens a record to find out whose a key is, because every open it does not want is a disclosure
 * against a patient who is not the subject of this export.
 */
async function exportByUrl(
  session: Session,
  args: Args,
  owners: GrantedOwner[],
  out: (s: string) => void,
  say: (s: string) => void,
): Promise<void> {
  const clientKey = clientKeyFromUrl(args.url!);
  const resolved = resolveOwner(clientKey, owners);
  const exportFrom = (open: OpenVault, key: string | undefined) =>
    exportOne(session, open, { ...args, client: args.client ?? key }, out);

  if (resolved.kind === "none") {
    throw new Error(`no record is approved for export, so "${clientKey}" names nobody — run --request <their email>`);
  }
  if (resolved.kind === "owner") {
    say(`${clientKey} → ${resolved.ownerAccountId} (${resolved.why})`);
    const open = await openGrantedVault(session, resolved.ownerAccountId);
    return exportFrom(open, findClientKey(open.vault.clients, clientKey));
  }
  if (!args.probe) {
    throw new Error(
      `"${clientKey}" is not the id of any approved account and ${resolved.candidates.length} are approved, so ` +
        `whose key it is can only be learned by opening each of them: ${resolved.candidates.join(", ")} — pass ` +
        "--patient <account-id> for the one you mean, or --probe to look",
    );
  }
  say(
    `--probe: opening up to ${resolved.candidates.length} record(s) to find "${clientKey}" — each open writes a ` +
      "row on that person's own access screen, including the records that turn out not to be the one",
  );
  for (const ownerAccountId of resolved.candidates) {
    const open = await openGrantedVault(session, ownerAccountId);
    const key = findClientKey(open.vault.clients, clientKey);
    if (!key) {
      say(`  ${ownerAccountId}: no "${clientKey}"`);
      continue;
    }
    return exportFrom(open, key);
  }
  throw new Error(`none of the ${resolved.candidates.length} approved records holds a client "${clientKey}"`);
}

if (isMain(import.meta.url)) {
  main().catch((e: Error) => {
    process.stderr.write(`record:export failed: ${e.message}\n`);
    process.exit(1);
  });
}
