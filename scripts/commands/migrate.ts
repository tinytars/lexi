// The one-time, in-place shape migrations.
//
// Each folds a retired field into its replacement and is self-terminating: once run, the next pass
// finds nothing to do. They are kept together because that is what they have in common — none of them
// is part of the ordinary ingest path, and reading ingest.ts should not mean reading all three.

import { randomUUID } from "node:crypto";
import type { Client, ClientFactors, LegacyFactors } from "../../src/lib/types";
import { normalizeTreatments } from "@pablotech/akesi-pil/treatment-normalize";
import { findingInputsHashOf, nodeHashesOf } from "../factors";

// W31 — one-time fold of the legacy medications/supplements/plan arrays into the unified
// `treatments` list (ISO-normalized). Plan-derived rows whose free-text date didn't parse are
// stamped to next month so they read as PLANNED (logged for manual cleanup in the web form).
// Idempotent: a no-op once `treatments` exists. Pair with --refresh-finding to regenerate.
export function migrateTreatments(client: Client): void {
  const f = client.factors as (ClientFactors & LegacyFactors) | undefined;
  if (!f) return;
  const hadLegacy = !!(f.medications || f.supplements || f.plan);
  const planActions = new Set((f.plan ?? []).map((p) => (p.action ?? "").trim()).filter(Boolean));
  const treatments = normalizeTreatments(f);
  const now = new Date();
  now.setUTCMonth(now.getUTCMonth() + 1);
  const nextMonth = now.toISOString().slice(0, 7);
  const restamped: string[] = [];
  for (const t of treatments) {
    if (!t.start && planActions.has(t.name.trim())) {
      t.start = nextMonth;
      restamped.push(t.name);
    }
  }
  client.factors ??= {};
  client.factors.treatments = treatments;
  const legacy = client.factors as Partial<LegacyFactors>;
  delete legacy.medications;
  delete legacy.supplements;
  delete legacy.plan;
  // The treatment CONTENT is unchanged (same drugs/doses/dates, only reshaped), so the existing
  // Finding is still an accurate function of the inputs — re-stamp its hashes to the new
  // canonicalization instead of paying for a full regen. This clears the transient "out of date"
  // that the shape change would otherwise show. A genuine content edit still marks it stale as usual.
  if (client.finding) {
    client.finding.inputsHash = findingInputsHashOf(client);
    client.finding.nodeHashes = nodeHashesOf(client);
  }
  if (hadLegacy) process.stdout.write(`migrated ${treatments.length} treatment(s) into the unified list; re-stamped Finding hashes\n`);
  if (restamped.length) {
    process.stdout.write(`  ⚠ unparseable plan date → set to ${nextMonth} (verify/fix in the form): ${restamped.join(", ")}\n`);
  }
}

// M65 — one-time fold of the retired `factors.correlations` array into `noteEntries` (which has
// no date field, so the date is embedded in the note text). Idempotent: a no-op once
// `correlations` is absent/empty. Modeled on migrateTreatments() above.
export function migrateCorrelations(client: Client): void {
  const f = client.factors as (ClientFactors & { correlations?: { date: string; event: string }[] }) | undefined;
  if (!f?.correlations?.length) return;
  f.noteEntries ??= [];
  const added: string[] = [];
  for (const c of f.correlations) {
    const text = `Correlation (${c.date}): ${c.event}`;
    f.noteEntries.push({ id: randomUUID(), text });
    added.push(text);
  }
  delete f.correlations;
  // The correlation CONTENT is unchanged (folded into noteEntries verbatim), so the existing
  // Finding is still an accurate function of the inputs — re-stamp its hashes to the new
  // canonicalization instead of paying for a full regen (same rationale as migrateTreatments above).
  if (client.finding) {
    client.finding.inputsHash = findingInputsHashOf(client);
    client.finding.nodeHashes = nodeHashesOf(client);
  }
  process.stdout.write(`migrated ${added.length} correlation(s) into noteEntries; re-stamped Finding hashes\n`);
  for (const text of added) process.stdout.write(`  + noteEntries: "${text}"\n`);
}

// M64 — one-time fold of the retired `factors.notes` scalar (a free-text Patient-profile field,
// distinct from the M63 `noteEntries` subsection) into `noteEntries` as a trailing entry.
// Idempotent: a no-op once `notes` is absent/empty. Modeled on migrateCorrelations() above.
export function migrateNotes(client: Client): void {
  // `notes` was removed from ClientFactors when M64 folded it into noteEntries, so it is reached
  // through the same retired-field cast migrateCorrelations() above uses for `correlations`.
  const f = client.factors as (ClientFactors & { notes?: string }) | undefined;
  if (!f?.notes?.trim()) return;
  f.noteEntries ??= [];
  const text = f.notes.trim();
  f.noteEntries.push({ id: randomUUID(), text });
  delete f.notes;
  // The note CONTENT is unchanged (folded into noteEntries verbatim), so the existing Finding is
  // still an accurate function of the inputs — re-stamp its hashes instead of paying for a full
  // regen (same rationale as migrateCorrelations above).
  if (client.finding) {
    client.finding.inputsHash = findingInputsHashOf(client);
    client.finding.nodeHashes = nodeHashesOf(client);
  }
  process.stdout.write(`migrated factors.notes into noteEntries; re-stamped Finding hashes\n`);
  process.stdout.write(`  + noteEntries: "${text}"\n`);
}
