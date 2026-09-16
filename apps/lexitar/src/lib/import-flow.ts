// W15/1 — the pure browser fold: turn a ProposedReport (from /api/extract) into an
// updated vault client, reusing the exact CLI logic (reportContribution + the
// report-merge folds + the provenance registry). Does no network and no crypto — the
// caller (ImportTab) hashes, extracts, PUTs the raw, and saves the vault around this.
import type { Client, SourceRecord, PendingUpload, MarkerResult } from "./types";
import type { ProposedReport, ReportPatient } from "@pablotech/akesi/report-extract";
import { reportContribution, type ReportContribution } from "./report-contribution";
import {
  applyReportContribution,
  pruneOrphanImagingMarkers,
  storedName,
  subtypeFor,
  upsertSourceRecord,
  hashSourceWeb,
  findSourceBySha,
} from "@pablotech/akesi/ingest-core";
import { applySourceReadings, type ApplyResult } from "@pablotech/akesi/report-merge";
import { EXTRACT_MODEL } from "./extract-config";
import { parseRawFile } from "./parse-raw";
import { normalizeClientId } from "./client-id";

// The minimized patient the report prompt needs — dob/gender + existing diagnosis
// names for naming consistency. NOT the whole vault (the server only ever sees this).
export function buildReportPatient(client: Client): ReportPatient {
  return {
    dob: client.dob,
    gender: client.gender,
    factors: {
      diseases: (client.factors?.diseases ?? []).map((d) => ({ diagnostic: d.diagnostic, date: d.date })),
    },
  };
}

export interface FoldResult {
  client: Client; // a clone with the report folded in — the prop is never mutated
  storedFile: string; // <date>-imaging-<subtype>-<sha8>.pdf — the raw's repo/R2 name
  studyType: string;
  contribution: ReportContribution;
  applied: ApplyResult;
}

// Fold a report into a CLONE of the client, mirroring scripts/ingest.ts:importReportsFor
// (minus the disk/LLM edges). `importedAt` is injected so the result is deterministic.
export function foldReport(
  client: Client,
  clientId: string,
  sha256: string,
  id: string,
  r: ProposedReport,
  originalName: string,
  importedAt: string,
): FoldResult {
  // JSON deep-clone (not structuredClone): the caller's client is a Svelte $state
  // proxy that structuredClone rejects, and the vault is pure JSON (it's what we
  // encrypt), so a round-trip is a faithful, proxy-free clone.
  const next: Client = JSON.parse(JSON.stringify(client));
  const contribution = reportContribution(next, id, r);
  const storedFile = storedName({
    sha256,
    kind: "imaging",
    subtype: subtypeFor("imaging", r.studyType),
    dates: [contribution.studyDate],
    ext: ".pdf",
  });
  const applied = applyReportContribution(next, id, contribution.diseases, contribution.markerRows);
  pruneOrphanImagingMarkers(next);

  const record: SourceRecord = {
    id,
    sha256,
    kind: "imaging",
    file: `records/private/${normalizeClientId(clientId)}/raw/${storedFile}`,
    originalName,
    studyType: r.studyType,
    studyDate: r.diseases[0]?.date ?? r.markers[0]?.date,
    importedAt,
    model: EXTRACT_MODEL,
    extraction: r,
    diseaseCount: r.diseases.length,
    markerCount: r.markers.length,
  };
  upsertSourceRecord(next, record);

  return { client: next, storedFile, studyType: r.studyType, contribution, applied };
}

export interface SourceFoldResult {
  client: Client; // a clone with the readings folded in — the prop is never mutated
  storedFile: string; // <date>-<type>-<subtype>-<sha8>.<ext> — the raw's repo/R2 name
  kind: SourceRecord["kind"];
  readingCount: number;
  dateStart?: string;
  dateEnd?: string;
  applied: { added: number; adopted: number; updated: number };
}

// W32 — the pure browser twin of scripts/ingest.ts:ingestSourceFile (minus the disk edges).
// Folds already-parsed lab/scale/dexa readings into a CLONE, mints the SAME canonical
// storedName the CLI would, so the raw's R2 key and the SourceRecord reconcile identically.
// It does NOT write the processed/ extraction artifact (that's Node/disk-only): processed/
// is a regenerable derived cache, and the readings already carry sourceId provenance.
export function foldSource(
  client: Client,
  clientId: string,
  sha256: string,
  id: string,
  parsed: { kind: SourceRecord["kind"]; rows: MarkerResult[] },
  ext: string,
  originalName: string,
  importedAt: string,
): SourceFoldResult {
  const next: Client = JSON.parse(JSON.stringify(client));
  const { kind, rows } = parsed;
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const storedFile = storedName({ sha256, kind, subtype: subtypeFor(kind), dates, ext: `.${ext}` });
  const applied = applySourceReadings(next, id, rows, false);
  upsertSourceRecord(next, {
    id,
    sha256,
    kind,
    file: `records/private/${normalizeClientId(clientId)}/raw/${storedFile}`,
    originalName,
    importedAt,
    dateStart: dates[0],
    dateEnd: dates[dates.length - 1],
    readingCount: rows.length,
  });
  return { client: next, storedFile, kind, readingCount: rows.length, dateStart: dates[0], dateEnd: dates[dates.length - 1], applied };
}

// ── W15/2 — pending (accept-anything) path: files the browser can't parse inline are
// stored raw + queued; the CLI processes them later. ──

// A safe, collision-resistant raw filename for a pending upload. The date/type are
// unknown at upload (no parse), so it's <sha8>-<safeOriginalName>; the CLI renames it
// to the canonical <date>-<type>-<subtype>-<sha8>.<ext> when it processes.
export function pendingRawName(sha256: string, originalName: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "upload";
  return `${sha256.slice(0, 8)}-${safe}`;
}

export function buildPendingUpload(sha256: string, id: string, originalName: string, uploadedAt: string): PendingUpload {
  return { id, sha256, file: pendingRawName(sha256, originalName), originalName, uploadedAt };
}

export function findPendingBySha(client: Client, sha256: string): PendingUpload | undefined {
  return client.pendingUploads?.find((p) => p.sha256 === sha256);
}

// Append a pending upload to a CLONE of the client (idempotent by sha256). The caller
// PUTs the raw and saves the returned client.
export function addPendingUpload(client: Client, upload: PendingUpload): Client {
  const next: Client = JSON.parse(JSON.stringify(client));
  next.pendingUploads ??= [];
  if (!next.pendingUploads.some((p) => p.sha256 === upload.sha256)) {
    next.pendingUploads.push(upload);
  }
  return next;
}

export type ClassifyResult =
  | { status: "duplicate"; existingId: string; kind: "report" | "source" | "pending" }
  | { status: "report"; id: string; fold: FoldResult; storedFile: string }
  | { status: "source"; id: string; srcFold: SourceFoldResult; storedFile: string }
  | { status: "pending"; id: string; pending: { upload: PendingUpload; client: Client }; storedFile: string }
  | { status: "error"; message: string };

// The pure hash/dedup/classify/fold spine of ImportTab.svelte's onFile — extracted so the
// browser Import tab and any future caller (e.g. a chat attachment) share one classification
// path. Does no state mutation and no network beyond extractReport (report path only).
export async function classifyUpload(client: Client, clientId: string, file: File): Promise<ClassifyResult> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { sha256, id } = await hashSourceWeb(bytes);
    const dupSrc = findSourceBySha(client, sha256);
    const dupPend = findPendingBySha(client, sha256);
    if (dupSrc || dupPend) {
      const dupKind: "report" | "source" | "pending" = dupSrc ? (dupSrc.kind === "imaging" ? "report" : "source") : "pending";
      return { status: "duplicate", existingId: (dupSrc ?? dupPend)!.id, kind: dupKind };
    }
    if (/\.pdf$/i.test(file.name)) {
      const { extractReport } = await import("./extract-client");
      const report = await extractReport(bytes, file.name, buildReportPatient(client));
      const fold = foldReport(client, clientId, sha256, id, report, file.name, new Date().toISOString());
      return { status: "report", id, fold, storedFile: fold.storedFile };
    } else {
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      try {
        const parsed = await parseRawFile(bytes, ext);
        if (!parsed.rows.length) throw new Error("no readings");
        const srcFold = foldSource(client, clientId, sha256, id, parsed, ext, file.name, new Date().toISOString());
        return { status: "source", id, srcFold, storedFile: srcFold.storedFile };
      } catch {
        const upload = buildPendingUpload(sha256, id, file.name, new Date().toISOString());
        const pendingResult = { upload, client: addPendingUpload(client, upload) };
        return { status: "pending", id, pending: pendingResult, storedFile: upload.file };
      }
    }
  } catch (e) {
    return { status: "error", message: (e as Error).message || "Could not read this file." };
  }
}
