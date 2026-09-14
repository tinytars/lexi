// R2 -> repo reconciliation, and folding the uploads a browser queued.
//
// W68 — lifted out of ingest.ts. The deployed vault is the source of truth; this is the one command
// that reads it back into the repo, so it is also the one place that materializes the files a pulled
// vault references. W67 found it materialized SourceRecords but never W46 attachments, while
// vault-verify checked both — the two now share one enumeration (attachment-keys.ts).

import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Client, InferenceMode, Vault } from "../../src/lib/types";
import { normalizeClientId } from "../../src/lib/client-id";
import type { UsageAccumulator } from "../inference-cost";
import { attachmentKeysOf } from "../../src/lib/attachment-keys";
import { decryptVault } from "@tinytars/vault/crypto";
import { parseRawFile } from "../parse-source";
import { processedPath, sha8Of, writeProcessed } from "../processed-store";
import { APP_ROOT, PRIVATE_DIR, clientPassOf, clientRawDir, fileExists, persistClientVault } from "../vault-io";
import { deleteRaw, pullRaw, pullVaultTo, pushRaw, push as pushVault, resolveStore } from "../vault-sync";
import { isV2, openV2 } from "../vault-v2";
import { orgSidecarFromD1 } from "../org-d1";
import { recordOrgKeyUse } from "../access-log";
import { importReportsFor, ingestSourceFile } from "./sources";

// W15/2 — fold every browser-uploaded pending file. Each entry's raw is already in R2
// (the browser PUT it); pull it to a temp file NAMED with the original filename (so the
// SourceRecord records the right originalName), then dispatch to the same ingest path a
// CLI import uses — imaging PDFs through the report extractor, everything else through
// the positional parser. On success the pending entry is dropped and its provisional R2
// key is returned for deletion (the caller replaces it with the canonical-named raw).
// A raw still missing from R2 (an incomplete upload) is left pending, not failed.
export async function processPendingFor(
  client: Client,
  clientId: string,
  mode: InferenceMode,
  usage: UsageAccumulator,
  dryRun = false,
): Promise<{ provisionalFiles: string[] }> {
  const pending = [...(client.pendingUploads ?? [])];
  const provisionalFiles: string[] = [];
  if (pending.length === 0) {
    process.stdout.write(`No pending uploads for ${clientId}.\n`);
    return { provisionalFiles };
  }
  if (dryRun) {
    process.stdout.write(`DRY-RUN process-pending: would process ${pending.length} upload(s) for ${clientId}:\n`);
    for (const p of pending) process.stdout.write(`  · ${p.originalName}\n`);
    // Empty on purpose: provisionalFiles is what the caller uses to decide it must push the folds
    // back to R2 and delete the browser's provisional keys. Nothing was folded, so nothing may move.
    return { provisionalFiles };
  }
  const store = resolveStore();
  process.stdout.write(`\nProcessing ${pending.length} pending upload(s) for ${clientId}…\n`);
  for (const p of pending) {
    const safeName = basename(p.originalName) || p.file;
    const dir = await mkdtemp(resolve(tmpdir(), `hd-pending-${p.id}-`));
    const tmpPath = resolve(dir, safeName);
    try {
      const pulled = await pullRaw(store, clientId, p.file, tmpPath);
      if (pulled === "missing") {
        process.stdout.write(`  ${p.originalName}: raw not in R2 (upload incomplete?) — left pending.\n`);
        continue;
      }
      const ext = safeName.toLowerCase().split(".").pop();
      if (ext === "pdf") {
        await importReportsFor(client, clientId, tmpPath, false, false, mode, usage);
      } else {
        await ingestSourceFile(client, clientId, tmpPath, false);
      }
      client.pendingUploads = (client.pendingUploads ?? []).filter((x) => x.sha256 !== p.sha256);
      if (client.pendingUploads.length === 0) delete client.pendingUploads;
      provisionalFiles.push(p.file);
    } catch (e) {
      process.stdout.write(`  ${p.originalName}: FAILED — ${(e as Error).message}. Left pending.\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { provisionalFiles };
}

// W15/2b — reconcile ONE client's repo plaintext with the authoritative R2 vault, so
// browser-only writes (uploads, edits) become durable git plaintext. R2 → repo:
//   1. pull the R2 vault to a temp .enc, decrypt it;
//   2. fold any pending uploads (mutates the vault, pushes the folds back to R2);
//   3. materialize any SourceRecord raw missing on disk (Phase-1 web uploads live only in R2);
//   4. backfill any missing processed artifact;
//   5. write vault.json + .enc ONLY when the vault CONTENT changed — a no-op leaves the
//      working tree clean (the .enc re-encrypts with a random IV, so a blind rewrite would
//      churn every run). Materialized raw/processed files are real additions and stay.
// vault:verify (the pre-push gate) is the final consistency check on the result.
export async function reconcileClient(
  id: string,
  store: string,
  mode: InferenceMode,
  usage: UsageAccumulator,
  dryRun = false,
): Promise<{ changed: boolean; rawsAdded: number; processedAdded: number }> {
  const vaultJsonPath = resolve(PRIVATE_DIR, normalizeClientId(id), "vault.json");
  const repoVault: Vault = (await fileExists(vaultJsonPath))
    ? JSON.parse(await readFile(vaultJsonPath, "utf8"))
    : { clients: {} };

  const tmpEnc = resolve(tmpdir(), `hd-reconcile-${normalizeClientId(id)}.enc`);
  const pulled = await pullVaultTo(id, tmpEnc, store);
  if (pulled === "missing") {
    process.stdout.write(`  ${id}: no vault in R2 — repo is the only copy (nothing to reconcile).\n`);
    return { changed: false, rawsAdded: 0, processedAdded: 0 };
  }
  // W44 P4c: the pulled R2 blob may have been re-keyed by a client rotation (support revoke/expiry), so
  // its DEK is sourced from the D1 org-recovery envelope (the source of truth for the live blob) rather
  // than the committed .dek.enc file, which can lag a prod rotation. For an un-rotated vault D1 returns
  // the identical envelope, so behaviour is unchanged. v1 path (below) is untouched.
  const pulledBlob = new Uint8Array(await readFile(tmpEnc));
  if (isV2(pulledBlob)) recordOrgKeyUse({ clientId: normalizeClientId(id), purpose: "ingest:reconcile" });
  const r2Vault = isV2(pulledBlob)
    ? await openV2<Vault>(pulledBlob, orgSidecarFromD1(normalizeClientId(id)))
    : await decryptVault<Vault>(pulledBlob, clientPassOf(id));
  await rm(tmpEnc, { force: true });

  const client = r2Vault.clients[id];
  if (!client) {
    process.stdout.write(`  ${id}: R2 vault has no client "${id}" — skipping.\n`);
    return { changed: false, rawsAdded: 0, processedAdded: 0 };
  }

  // Fold any queued uploads into the R2 vault (also pushes the folds back to R2 below).
  const pendingResult = await processPendingFor(client, id, mode, usage, dryRun);

  // Materialize any raw missing on disk — recovers Phase-1 web-uploaded reports (R2-only).
  if (!dryRun) await mkdir(clientRawDir(id), { recursive: true });
  let rawsAdded = 0;
  for (const s of client.sources ?? []) {
    const rawFile = basename(s.file);
    const dest = resolve(clientRawDir(id), rawFile);
    if (await fileExists(dest)) continue;
    if (dryRun) { rawsAdded++; continue; }
    const got = await pullRaw(store, id, rawFile, dest);
    if (got === "missing") process.stdout.write(`  ${id}: raw "${rawFile}" not in R2 (source ${s.id}) — cannot materialize.\n`);
    else rawsAdded++;
  }

  // W46 attachments (photos/documents on a treatment, note, idea, study, allergy, family entry or
  // diagnosis) live in the same raw/ dir but are NOT SourceRecords, so the loop above never saw them.
  // vault-verify has always checked them, which meant a reconcile could leave the repo permanently
  // faulted for an attachment it was never given a chance to fetch. Same enumeration both sides now.
  for (const { label, key } of attachmentKeysOf(client)) {
    const dest = resolve(clientRawDir(id), key);
    if (await fileExists(dest)) continue;
    if (dryRun) { rawsAdded++; continue; }
    const got = await pullRaw(store, id, key, dest);
    if (got === "missing") process.stdout.write(`  ${id}: attachment "${key}" not in R2 (${label}) — cannot materialize.\n`);
    else rawsAdded++;
  }

  // Backfill any missing processed artifact (imaging → the stored extraction; positional →
  // re-parse the raw, which must now be present on disk).
  let processedAdded = 0;
  for (const s of client.sources ?? []) {
    const sha8 = sha8Of(s.sha256);
    if (await fileExists(processedPath(id, sha8))) continue;
    if (dryRun) { processedAdded++; continue; }
    if (s.kind === "imaging") {
      if (!s.extraction) continue;
      await writeProcessed(id, { sha256: s.sha256, sha8, kind: "imaging", sourceFile: s.file, extractedAt: s.importedAt, model: s.model, data: s.extraction });
    } else {
      if (!(await fileExists(resolve(APP_ROOT, s.file)))) continue;
      const { rows } = await parseRawFile(resolve(APP_ROOT, s.file));
      await writeProcessed(id, { sha256: s.sha256, sha8, kind: s.kind, sourceFile: s.file, extractedAt: s.importedAt, data: { rows } });
    }
    processedAdded++;
  }

  // Write plaintext only when the vault content actually differs from the repo.
  const changed = JSON.stringify(r2Vault) !== JSON.stringify(repoVault);
  if (dryRun) {
    process.stdout.write(
      `DRY-RUN reconcile ${id}: vault ${changed ? "differs from" : "matches"} R2; ` +
        `${rawsAdded} raw + ${processedAdded} processed file(s) missing locally. Nothing written.\n`,
    );
    return { changed, rawsAdded, processedAdded };
  }
  if (changed) {
    await persistClientVault(id, r2Vault);
    process.stdout.write(`  ${id}: vault.json + .enc updated from R2.\n`);
  }

  // A pending fold changed the vault beyond what R2 held — push the folded source + canonical
  // raws back, and delete the provisional (<sha8>-<name>) keys the browser PUT.
  if (pendingResult.provisionalFiles.length > 0) {
    await pushVault(id);
    const files = (await readdir(clientRawDir(id))).filter((f) => !f.startsWith("."));
    for (const f of files) await pushRaw(store, id, f, resolve(clientRawDir(id), f));
    for (const f of pendingResult.provisionalFiles) await deleteRaw(store, id, f);
    process.stdout.write(`  ${id}: pushed ${pendingResult.provisionalFiles.length} folded upload(s) back to R2.\n`);
  }

  if (rawsAdded || processedAdded) {
    process.stdout.write(`  ${id}: materialized ${rawsAdded} raw + ${processedAdded} processed file(s).\n`);
  }
  return { changed, rawsAdded, processedAdded };
}
