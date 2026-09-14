// One-off tool: re-run the app's own "Identify from photos" extraction (inferTreatment,
// src/lib/treatment-infer.ts) against attachments a treatment ALREADY has on file, for a treatment
// that was hand-entered and never went through the app's Identify+Save flow. Exists because that
// flow only runs from the browser (UnifiedTreatment.svelte) — there is no CLI/script path to it, and
// a handful of Alex's real treatments (e.g. N-Acetyl-L-Cysteine) have real label photos attached
// (added via the app) but were never actually identified against them.
//
// Mirrors UnifiedTreatment.svelte's medicine-scope save fan-out exactly (M-doseunit-relabel): every
// dose row sharing the treatment's name gets the same administration/ingredients/description, and
// doseUnit is relabeled to the new administration.unit — the only way computeConclusion's Daily
// total ever unlocks for a legacy row. doseAmount is left untouched (same assumption the UI's save
// makes: the existing numeric value is already a count of whatever unit administration fixes).
//
// This only patches the vault entry and prints/persists the result — it does NOT force-regen any
// leaf. Run scripts/treatment-groups-backfill.ts --client <id> afterward (staleNodes() will correctly
// pick up patientPlan's drift from the administration change and regen treatmentGroups/aiOnPlan etc.
// at the leaf tier, cheap — no full core regen needed since patientPlan is a "source" node, not core).
//
//   npx tsx scripts/treatment-photo-extract.ts --client Alex --name "N-Acetyl-L-Cysteine" \
//     --key 85ed692a-image.jpg --key cbac0c37-image.jpg [--save]
//
// Without --save, prints the proposed extraction and the rows it would touch, and stops there.
//
// Pass --id <treatmentId> when two rows share a name but are NOT the same medicine's dose-history
// (see the row.rawCaptureAttachmentKeys comment below) — narrows the match to that one row instead
// of stamping the extraction onto every same-named row.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import "./load-creds";
import { inferTreatment } from "@pablotech/akesi-pil/treatment-infer";
import { TREATMENT_IMAGE_MODEL, TREATMENT_INFER_MAX_TOKENS } from "../src/lib/treatment-infer-config";
import { administrationUnitChanged } from "@pablotech/akesi-pil/treatment-product";
import type { TreatmentItem } from "../src/lib/types";
import { clientRawDir, loadClientVault, persistClientVault } from "./vault-io";
import { pull as pullVault, push as pushVault } from "./vault-sync";
import { UsageAccumulator } from "./inference-cost";

// --id narrows a same-named match to one specific row, for the case the header comment above warns
// about: two rows sharing a name that are NOT the same medicine's dose-history fan-out, but
// coincidentally-named separate products with their own distinct photo. Omit --id and every
// same-named row still gets the shared extraction, unchanged — that fan-out is deliberate (mirrors
// UnifiedTreatment.svelte's medicine-scope save).
export function selectTreatmentRows(treatments: TreatmentItem[], name: string, rowId?: string): TreatmentItem[] {
  const prev = name.trim().toLowerCase();
  const byName = treatments.filter((t) => t.name.trim().toLowerCase() === prev);
  return rowId ? byName.filter((t) => t.id === rowId) : byName;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const id = flag("--client");
  const name = flag("--name");
  const rowId = flag("--id");
  const keys = args.flatMap((a, i) => (a === "--key" ? [args[i + 1]] : []));
  const save = args.includes("--save");
  const noSync = args.includes("--no-sync");
  if (!id || !name || keys.length === 0) {
    throw new Error(
      'usage: --client <id> --name "<treatment name>" [--id <treatmentId>] --key <file> [--key <file> ...] [--save] [--no-sync]',
    );
  }

  // --no-sync: skip the wrangler pull/push (offline preview against whatever plaintext is already
  // checked out locally) — wrangler's own fetch client, not the plain Anthropic SDK call below, is
  // what a workstation VPN breaks (see CLAUDE.md's local-execution policy).
  if (!noSync) await pullVault(id);
  const vault = await loadClientVault(id);
  const client = vault.clients[id];
  if (!client) throw new Error(`${id}: no such client`);
  const rows = selectTreatmentRows(client.factors?.treatments ?? [], name, rowId);
  if (rows.length === 0) {
    throw new Error(`${id}: no treatment rows named "${name}"${rowId ? ` with id "${rowId}"` : ""}`);
  }

  const rawDir = clientRawDir(id);
  const images = keys.map((key) => {
    const bytes = readFileSync(`${rawDir}/${key}`);
    const mediaType = key.toLowerCase().endsWith(".png") ? ("image/png" as const) : ("image/jpeg" as const);
    return { base64: bytes.toString("base64"), mediaType };
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const usage = new UsageAccumulator();
  const anthropic = new Anthropic({ apiKey });
  const proposed = await inferTreatment(anthropic, { images }, TREATMENT_IMAGE_MODEL, TREATMENT_INFER_MAX_TOKENS, usage);

  process.stdout.write(`${id}: proposed extraction for "${name}":\n${JSON.stringify(proposed, null, 2)}\n`);
  process.stdout.write(`Would touch ${rows.length} row(s): ${rows.map((r) => `${r.doseAmount ?? "?"} ${r.doseUnit ?? "?"}`).join(", ")}\n`);

  if (!save) {
    process.stdout.write("Preview only — pass --save to apply and persist.\n");
    return;
  }

  const prevAdministration = rows[0].administration;
  const relabelUnit = administrationUnitChanged(prevAdministration, proposed.administration) ? proposed.administration!.unit : null;
  for (const row of rows) {
    row.description = proposed.description;
    row.maker = proposed.maker;
    row.ingredients = proposed.ingredients ? [...proposed.ingredients] : undefined;
    row.links = proposed.links ? [...proposed.links] : undefined;
    row.administration = proposed.administration ? { ...proposed.administration } : undefined;
    row.extracted = { via: "photo", at: new Date().toISOString() };
    // A sibling row sharing this name may carry a DIFFERENT physical photo capture (its own
    // `attachments`), not the one named on the CLI — stamping the CLI's --key list onto every
    // matched row claimed evidence a row didn't have (found live: 8eeea28b-... inherited two
    // keys belonging to a different NAC row entirely, tripping report-merge's raw-capture check).
    row.rawCaptureAttachmentKeys = (row.attachments ?? []).map((a) => a.key);
    if (relabelUnit != null) row.doseUnit = relabelUnit;
  }

  await persistClientVault(id, vault);
  if (!noSync) await pushVault(id);
  process.stdout.write(`${id}: saved${noSync ? " (local only, --no-sync)" : ""}. Run treatment-groups-backfill.ts --client ${id} next to refresh dependent leaves.\n`);
}

// Guarded like document-read-check.ts and dose-backfill.ts — an unguarded top-level body bills an
// Anthropic call the moment anything (e.g. a test) imports selectTreatmentRows from this file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
