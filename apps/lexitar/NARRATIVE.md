# Narrative medical reports: ingest, range, interpret

How LexiTar (`apps/lexitar`) ingests **free-text radiology / imaging reports** — e.g.
Epic MyChart "Test Details" PDFs (coronary CTA, abdominal ultrasound, renal,
echocardiogram). These are prose documents (HISTORY / TECHNIQUE / FINDINGS /
IMPRESSION), with dates and study types in varying places. They are **not** the
positional DEXA-table format (`DEXA.md`) and **not** lab spreadsheets
(`BLOOD.md`), so they take their own LLM-based path — they do **not** flow
through the extension routing in `INGEST.md`.

This is the third ingest source, layered on the shared model: a report yields
both **`Diagnosed Disease` entries** (the `diseases` factor) and **quantified
imaging markers** (`MarkerResult` readings, `source: "Imaging"`). The disease
entries are consumed directly by the Finding; the markers flow into the same
**range** and **interpret** stages as every other marker (`BLOOD.md`).

```
Import tab (src/lib/ImportTab.svelte) ← a .pdf
  → sha256(bytes) → source id (dedup key + provenance tag)
  → already in client.sources with a cached extraction? REUSE it
       (deterministic, no LLM call)
  → else POST /api/extract (functions/api/extract.ts): the PDF goes to Claude as a
       document block and comes back a validated ProposedReport
  → canonicalize each marker name (@pablotech/akesi/imaging-catalog)
  → foldReport (src/lib/import-flow.ts) folds it into a CLONE of the decrypted vault:
       reconcile this source's diseases + imaging markers by sourceId,
       cache the extraction, upsert into client.sources, prune orphans
  → preview table → ImportTab PUTs the raw bytes and saves the re-encrypted vault

A PDF the browser queued rather than read is folded later, server-side, by
  npm run r2-ops -- --process-pending --client <id>
```

---

## 1. Ingest — the Import tab, and `--process-pending` behind it

Unlike blood/DEXA (deterministic parsers behind the positional path), reports go
through Claude. There are two ways in and they differ only in who reads the PDF:

- **The Import tab**, which is the one a patient uses. The browser hashes the file
  and POSTs it to `/api/extract`, which hands the PDF to Claude as a document block
  — there is no pdfjs on the Workers runtime, so no text is extracted first — and
  returns a validated `ProposedReport` the browser folds in client-side. The vault
  plaintext and its keys never leave the browser; the report itself does, which is
  a bounded and documented exposure.
- **`npm run r2-ops -- --process-pending`**, which folds what the browser queued
  but could not read. This is the only path that runs pdfjs: `extractReportText`
  (`@pablotech/akesi/pdf-node`) flattens each page to plain prose, reusing that
  package's loader rather than keeping the positional `{str,x,y}` items `parseDexa`
  needs, and the text goes to the model in place of the document block.

Re-reading a PDF already on file is never automatic in either path: the cached
extraction in its `SourceRecord` is reused, so the same bytes cannot drift into a
second series.
- **LLM extraction** — `scripts/claude-report.ts` (`proposeFromReport`) mirrors
  the `claude-ranges.ts` shape: singleton Anthropic client on
  `ANTHROPIC_API_KEY`, ephemeral-cached system prompt, structured output via a
  JSON schema (`REPORT_SCHEMA`), parse → `validate()` → `usage?.record(...)`.
  Returns `{ studyType, diseases[], markers[] }`; both arrays may be empty (a
  clean report). It is given **Today** and the patient context.
- **Extraction rules** (in the system prompt):
  - one disease entry per **distinct** finding, in the terse house style
    (`"CAC: 210; CAD-RADS 3 in the Proximal RCA"`); a quantitative result and its
    category/grade are folded into **one** line, not split;
  - `date` = the **exam-performed** date (study/collection, not order/result),
    `YYYY-MM-DD` when unambiguous else the report's own text;
  - a `marker` only for a **genuinely quantified** value (CAC score, a measured
    dimension); a category like `1-24%` stays in the disease line, never becomes
    a numeric marker; no fabricated numbers for qualitative findings;
  - **canonical names** — the prompt carries the `CANONICAL_IMAGING_MARKERS`
    vocabulary and asks the model to name the same metric identically across
    reports. Every extracted name is then run through `canonicalImagingMarker`
    (`@pablotech/akesi/imaging-catalog`) before storage, so "LVEF" and "LV Ejection
    Fraction (Biplane Simpson)" land as one series. This is the imaging analogue
    of the stable names blood/DEXA emit by construction. Unknown names pass
    through — extend the alias map as new metrics appear.
- **Model tier** — the `extract` feature in `inference.config.json`: `dev` = Sonnet,
  `prod` = Opus. Cost is reported per run like every other API call. As with the
  Anthropic SDK elsewhere, runs need `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem`.

### Apply semantics — incremental & provenance-scoped

Each source is identified by `sha256(bytes)` (its **source id** = first 12 hex,
via `scripts/sources-store.ts`). This is shared with the blood/DEXA paths — see
`INGEST.md`. Apply is per source (`applyReportContribution` in
`@pablotech/akesi/ingest-core`, over the folds in
`@pablotech/akesi/report-merge`), not a global replace:

- **Scoped & idempotent.** Before adding, the source's *prior* contribution is
  removed (diseases + `Imaging` results with this `sourceId`), then the set is
  added back. Re-importing the same PDF refreshes only that source and never
  accumulates duplicates; hand-entered and other sources' entries are untouched.
- **Cached & deterministic.** The extraction is cached in the `SourceRecord`. A
  re-import of identical bytes **reuses the cache** (no LLM call, no name drift).
  This — plus canonical names — is what prevents the orphan duplicate markers that
  name-drift used to leave behind. **Nothing exposes a re-extract**: the flag that
  forced one went with the ingest CLI, and the Import tab reports a duplicate
  rather than offering to overwrite it.
- **Adoption.** If an extracted entry matches an existing **provenance-less** one
  (disease by normalized `date|diagnostic`; `Imaging` marker by `marker|date`),
  the existing row is *adopted* (stamped with this `sourceId`) instead of
  duplicated. This is how pre-provenance imports migrated.
- **Orphan prune.** After applying, `pruneOrphanImagingMarkers` drops any
  `Imaging` result with no `sourceId` or a `sourceId` not in `client.sources`.
- **Provenance pointers.** Every disease/marker carries `sourceId` (invisible to
  the factors/finding hashes and renderers — they read only the core fields).
- **Duplicate detection.** A content hash already in `client.sources` is reported as
  a duplicate and nothing is written — the Import tab says so and stops.
- **Preview before commit.** The browser shows the proposal table from the folded
  clone and persists nothing until it is accepted, which is where the cheap `dev`
  review happens.

---

## 2. Range — imaging markers (shared pipeline)

Report-derived markers (`source: "Imaging"`) are ordinary `MarkerResult`s, so
they get personalized ranges through the exact path in `BLOOD.md §1` once put on
the watchlist (`--add-marker "Coronary artery calcium (CAC) score"`). Disease
entries are **not** markers — they carry no range and no time series; they are
the Diagnosed Disease factor, read straight into the Finding.

---

## 3. Interpret — feeding the Finding

The imported data lands exactly where the Finding's logic already looks
(`scripts/claude-finding.ts`, see `BLOOD.md §2`):

- **Diagnosed Disease** drives the "re-scan every prior diagnosis" rule of the
  data requisition: each imported diagnosis with a stale study date produces a
  re-imaging line with elapsed-time rationale (a 2021 CAC → repeat CAC/CTA; a
  2019 steatosis → FibroScan / MRI-PDFF; a bicuspid-AV note → echocardiogram).
  Importing reports therefore both corrects dates and surfaces re-scans the
  hand-entered history was missing.
- **Imaging markers** appear in the on-file census with their recency tags and
  can be recommended/requisitioned like any marker.

Regenerate on demand after an import (the Finding is never auto-refreshed):
`npm run r2-ops -- --refresh-finding --client <id>`.

---

## Provenance & storage

Reports use the **shared** source-provenance machinery (`INGEST.md`):

- **Source PDFs were kept in the repo** at
  `apps/health-dash-web/sources/<client-id>/<date>-imaging-<subtype>-<sha8>.pdf`
  (e.g. `2021October15-imaging-coronary-13da11c4.pdf`), committed — in `plover-code`,
  which this app was imported from. **Neither the path nor the policy is true here**,
  corrected 2026-10-06: `apps/lexitar` has no `sources/` directory and tracks not one
  of those files, and the premise the parenthesis rested on — "this private repo commits
  secrets/vaults by policy" — describes a repository that has been public since
  2026-09-09. An original now reaches R2 sealed under a per-file content key minted in
  the browser (`src/lib/raw-cipher.ts`, §2a of `VAULT.md`) and is never committed
  anywhere. What survives of the old arrangement is the reason for it: a source document
  must be version-addressable without being servable, which `sources/` bought by sitting
  beside `public/` rather than inside it.
- **Registry.** `client.sources: SourceRecord[]` (`kind: "imaging"` for reports)
  records `id`, `sha256`, stored `file`, original name, study type/date, import
  timestamp, model/mode, the cached `extraction`, and counts.
- **Trace an entry to its source**: a disease/marker's `sourceId` → the matching
  `client.sources[].file`.

## Caveats

- **Drift is contained, not eliminated.** Caching makes re-imports of the *same*
  PDF deterministic, and the canonical catalog unifies known names; but a *new*
  report naming a metric the catalog doesn't know will still start its own series
  until that name is added to `@pablotech/akesi/imaging-catalog`. The alias map is the knob.
- **Layout-independent, but model-dependent.** Extraction quality is the model's —
  the preview the Import tab shows before committing is the human-review gate (see
  the `llm-output-trust` skill before changing the model/prompt/schema).

The vault model, encryption, and the `MarkerResult` shape are unchanged — see
`INGEST.md`.
