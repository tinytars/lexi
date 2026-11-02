# Ingest: lab files → stored readings

The shared first stage for **every** marker source in this app. A raw
file becomes a list of normalized readings in the patient's encrypted vault; the
later **range** and **interpret** stages then act on those readings (see
`BLOOD.md` and `DEXA.md`, which now cover only range + interpret).

```
  upload ──▶ hash + dedup ──▶ classify ──▶ parse ──▶ MarkerResult[] ──▶ fold ──▶ vault
 (.xlsx/.pdf)   (by sha256)    (extension,   (per source)          (marker|date)   data-<id>.enc
                                then content)
```

**Two entry points, one spine.** The browser's Import tab folds a file inline
(`src/lib/ImportTab.svelte` → `classifyUpload`, `src/lib/import-flow.ts:173`); anything it
cannot parse is stored raw and queued, then folded later by the CLI
(`npm run r2-ops -- --process-pending --client <id>` → `opProcessPending`,
`scripts/commands/r2-ops.ts:158`). Both route through the same `parseRawFile` and the same
`foldSource`/`foldReport`, so a file folds identically whichever way it arrived.

**There is no local-path ingest.** The CLI acts on what the browser has already uploaded to
R2 and never reads a file from your disk.

---

## The reading model

Every source — blood, DEXA, scale — emits the same `MarkerResult`
(`src/lib/types.ts:1`):

```ts
{ marker, group, source, date, value, unit, ref?: { low?, high? } }
```

- `marker` — a **canonical** name chosen by the parser, not whatever the file
  prints.
- `group` — the parser's grouping (e.g. `Lipid Panel`, `Body Composition – Total`).
- `source` — `"Blood"`, `"Scan"` (DEXA), or `"Scale"`.
- `date` — normalized to `YYYY-MM-DD`.
- `value` — finite number; non-numeric cells are dropped.
- `unit` — the stored unit (canonicalized at parse time; see per-source notes).
- `ref` — the lab's own reference interval where the source provides one (blood
  only). This is the *lab* range, distinct from the personalized range.

`client.results` holds the **full inventory** — every reading ever loaded.

---

## Source detection — the extension splits PDFs off, content does the rest

A `.pdf` is split off **by filename** at both entry points (`src/lib/import-flow.ts:184`,
`scripts/commands/r2-ops.ts:112`) and goes to the LLM report path. Everything else reaches
`parseRawFile` (`src/lib/parse-raw.ts:12`), where a spreadsheet is routed **by content**: a
sheet neither sniffer recognizes throws rather than being parsed as a lab export on the
assumption that it must be one.

| Input | Decided by | Parser | Source label |
|-------|-----------|--------|--------------|
| `.pdf` | filename, before `parseRawFile` | LLM extraction → `foldReport` | per report (see `NARRATIVE.md`) |
| `.xlsx` / `.xls`, sheet looks like a scale export | `isWeightAppSheet` (`src/lib/parsers/weightapp.ts:47`) | `parseWeightApp` | Scale / InBody body-comp |
| `.xlsx` / `.xls`, sheet looks like a HealthMatters export | `isHealthmatters` (`src/lib/parsers/healthmatters.ts:87`) | `parseHealthmatters` | Blood labs |
| `.xlsx` / `.xls`, neither | — | throws `unrecognized spreadsheet format` | queued, not guessed |
| anything else | — | throws `unsupported file extension` | queued, not guessed |

**A throw here is not a failure.** The caller catches it and stores the file as a **pending
upload** (`src/lib/import-flow.ts:195`) — kept, hashed and listed, waiting for a parser that
understands it — which is why the table has no "rejected" row.

> **`parseDexa` is on no live path.** `src/lib/parse-raw.ts:23` still routes `.pdf` to it,
> but both callers divert `.pdf` to the report path before `parseRawFile` is reached, so a
> DEXA report is extracted today by the same LLM path as any other PDF. The section below
> describes a parser that is still tested (`tests/unit/dexa-parser.test.ts`) and no longer
> called.

---

## Blood labs — `parseHealthmatters`

Standard HealthMatters export. Per row:

- **value** — `parseFloat` after coercion; non-finite dropped.
- **date** — Excel serial dates and string dates both normalized to `YYYY-MM-DD`.
- **unit** — taken from the file, then **canonicalized** by a per-marker
  `normalize()` step so stored values are comparable across labs: triglycerides /
  glucose / cholesterol mmol/L → mg/dL, apolipoproteins g/L → mg/dL, etc.
- **ref** — the lab's own reference interval, parsed from free text
  (`"150 - 250"`, `"< 100"`, `"> 40"`) into `{low, high}`.

---

## DEXA scans — `parseDexa`

DEXA reports are positional tables, not tagged data. The parser uses `pdfjs-dist`
to pull every text item with its rounded `(x, y)` page coordinates
(`dexa.ts:127-143`), then reads values **by coordinate**:

- `findLabelY(page, label, xMin, xMax)` — locate a row by its label within an
  x-band (`dexa.ts:78`).
- `findValueAt(page, x, y, tol)` — grab the numeric cell nearest a target `x` on
  that row's `y` (`dexa.ts:65`); commas stripped, non-numeric ignored.

Because it reads by hard-coded column x-offsets (`BC_COLUMNS` / `BMD_COLUMNS`,
`dexa.ts:37,52`; page-1 value column `x=537`, `dexa.ts:159`), the parser is tied
to **one DEXA report layout**. A different template silently yields fewer rows
rather than erroring.

**Scan date is required.** `findScanDate` reads the `Scan Date` value as
European `DD/MM/YYYY` and converts to `YYYY-MM-DD` (`dexa.ts:58,86`); if absent,
`parseDexa` throws (`dexa.ts:146`). Every reading from the file shares that date.

What gets extracted (all `source: "Scan"`, `dexa.ts:150`):

| Group | What | Source in parser |
|-------|------|------------------|
| `Body Composition – Total` | Whole-body indices: total weight, BMI, BMR, % Fat, FMI, android/gynoid ratios, **VAT area / mass / volume**, SAT area, % Lean, LMI, ALMI, % Bone, BMC/height² | `COMPOSITION_INDICES` (`dexa.ts:13`), page 1 at `x=537` |
| `Body Composition – Regional` | Per-ROI % Fat, tissue/fat/lean mass, areas, total mass (arms, ribs, spine, pelvis, legs, head, android, gynoid…) | `ROIS_BC` × `BC_COLUMNS` (`dexa.ts:33,37`) |
| `Bone Density – Regional` | Per-ROI BMD, BMC, bone area | `ROIS_BMD` × `BMD_COLUMNS` (`dexa.ts:48,52`), page 2 |
| `Bone Density` | Whole body **T-score** and **Z-score** | `findTScoreZScore` (`dexa.ts:115`) |
| `Anthropometrics` | Height (cm), Weight (kg) scalars | `findScalar` (`dexa.ts:185`) |

Units are assigned per-marker by the parser (g, kg, cm², cm³, %, g/cm², kg/m²,
dimensionless ratios, unitless T/Z scores). Masses are stored **raw in grams**;
the `g → kg` / imperial display conversion is a downstream render concern
(`src/lib/units.ts`, documented in `DEXA.md`).

---

## Scale / InBody — `parseWeightApp`

Day-to-day body composition from an InBody / smart-scale `.xlsx`, used when
`isWeightAppSheet` matches (sheet named `inbody`, or `date`+muscle+fat columns,
`weightapp.ts:50`). Emits `source: "Scale"` markers — `Weight (Scale)`,
`Skeletal muscle mass (Scale)`, `Body fat mass (Scale)` — deliberately suffixed
`(Scale)` so they stay distinct from DEXA readings rather than colliding on the
same marker name. DEXA is the periodic ground truth; the scale is the dense
in-between trend.

---

## Dedup and storage

New readings fold into `client.results` keyed by `marker|date` — `applySourceReadings`, in
the shared `@pablotech/akesi/report-merge`, called from `src/lib/import-flow.ts:118` — so
re-importing the same draw/scan is a no-op; a new date appends a fresh time point per marker.

---

## Source provenance (all sources)

Every ingested source file — lab xlsx, DEXA/scale export, report PDF — is now
retained and tracked, sharing one mechanism (`scripts/sources-store.ts`):

- **Content hash → `sourceId`** = `sha256(bytes).slice(0,12)`. Re-ingesting an
  identical file is **detected and reported** (positional files skip re-parse
  unless `--force`; reports reuse their cached extraction — see `NARRATIVE.md`).
- **The file is retained** under a **self-describing name**
  (`storedName`, in `src/lib/ingest-core.ts`):
  **`<date>-<type>-<subtype>-<sha8>.<ext>`** — e.g.
  `2021October15-imaging-coronary-13da11c4.pdf`,
  `2025September02-2026May19-blood-panel-<sha8>.xlsx`.
  - `<date>` is `YYYYMonthDD`; a multi-date file (a longitudinal lab panel) uses
    the full `start-end` range, a single-date one (imaging/DEXA) collapses to one.
  - `<type>` ← kind (`lab→blood`, `dexa`, `scale`, `imaging`); `<subtype>` is
    `panel`/`bodycomp`/`inbody` for those, and the study region for imaging
    (`slugStudyType`: "Renal Ultrasound" → `renal`).
  The raw file is never served directly — see `VAULT.md` for the storage model.
  A pre-fold **processed artifact** is written per source at apply time (the
  faithful, pre-dedup extraction).
- **Every reading carries `sourceId`** (`MarkerResult.sourceId`), and each source
  is registered in **`client.sources: SourceRecord[]`** (`kind`:
  `lab|dexa|scale|imaging`, the stored `file`, date range / study date, counts,
  and — for imaging — the cached `extraction`). `sourceId` is excluded from the
  factors/finding hashes.
- **Adoption.** Like the imaging path, positional ingest (`ingestSourceFile` →
  `applySourceReadings`) *adopts* an existing provenance-less reading it
  re-encounters by `marker|date` (stamps it with this file's `sourceId`) rather
  than duplicating — so feeding a cumulative lab export back-fills provenance on
  the prior history. The first file to introduce a reading owns it.
- Spreadsheets fold through `foldSource` (`src/lib/import-flow.ts:104`), report PDFs
  through `foldReport` (`src/lib/import-flow.ts:46`). Both mint the same `storedName`, so
  the raw's R2 key and its `SourceRecord` reconcile whichever route the file took. There is
  no rename pass for files stored under an older scheme.

### Removing a source

A source is one deletable unit: `{ raw file, processed artifact, SourceRecord, all
derived data tagged with its sourceId }`. It is removed from the **Reports** surface in the
app (`src/lib/HealthReports.svelte:91`), which calls the raw DELETE route
(`functions/api/raw/[[path]].ts:246`) to drop the R2 objects.

Both ends run the same pure `removeSource()` (`@pablotech/akesi/report-merge`): it drops the
`SourceRecord` and every `sourceId`-tagged reading/disease (incl. `fromComparison`
placeholders and folded comorbidity codes), **keeps a reading a surviving source also
supplies** (re-attributed — corroboration), and appends a PHI-free tombstone to
`client.removedSources[]` (`{sourceId, sha8, kind, removedAt}`). It then deletes the raw +
processed files on disk and the R2 `{store}/raw|processed` objects, re-derives the `.enc`,
and prints a git-history note. **Idempotent** (an unknown/already-removed token is a no-op;
no duplicate tombstone). **Re-ingesting the same sha clears its tombstone.**

- **Removed ≠ stale.** Removed data is *gone*; a removal also makes the Finding **stale**
  (its `inputsHash` no longer matches), which is a separate "needs regen" state — the
  deleted readings are not rendered as stale.
- `vault:verify` enforces the **provenance invariant** (no dangling `sourceId`, no
  tombstone/live collision, every source has its raw + processed files), so a bad delete
  fails the pre-push gate.
- The working tree, served `.enc`, and R2 are cleaned immediately. For a sensitive
  (wrong-patient) removal, see `AUTH.md` for account/data erasure.

### Cross-source naming & provenance — the two-way lesson

The deterministic blood/DEXA parsers emit **stable canonical names** by
construction (lab-export names; DEXA's fixed catalog), so their `marker|date`
identity is reliable. The LLM-driven imaging path does not, which caused
duplicate/orphan markers. The fix flowed **both ways**:
- **blood/DEXA → imaging**: imaging adopted canonical naming
  (`src/lib/imaging-catalog.ts`) + deterministic re-import (cached extraction).
- **imaging → blood/DEXA**: blood/DEXA adopted imaging's provenance — keep the
  source file, hash-dedup re-ingest, tag each reading with its `sourceId`.

---

## Watchlist vs. inventory vs. recommended

- **Inventory** (`client.results`) — every reading on file.
- **Watchlist** (`client.watchlist`) — the subset the provider actively tracks;
  drives which markers get personalized ranges and the detailed Markers block in
  the Finding. For a DEXA metric to be tracked/targeted it must be added here.
- **Recommended** (`client.recommended`) — markers the AI Finding surfaced;
  maintained by `npm run r2-ops -- --refresh-finding --client <id>`.

Watchlist membership is edited in the app: the Pin/Unpin control on a marker
(`src/lib/MarkerChart.svelte:38`), read back by the Markers tab
(`src/lib/MarkersTab.svelte:208`).

---

## Clinical context (factors)

The patient context the range and interpret stages consume is stored in `client.factors`
and edited in the app, not from a CLI — diagnoses, medications and supplements in
`src/lib/Personalization.svelte`, allergies in `src/lib/Allergies.svelte`, family history in
`src/lib/Family.svelte`, notes in `src/lib/Notes.svelte`.

A `factorsHash` is recomputed on every change so the range/finding stages know
when context changed (range staleness, finding `inputsHash`).

---

## Encryption at rest (`src/lib/crypto.ts`)

AES-GCM 256, key via PBKDF2-SHA256 (200k iterations), random salt + IV per write,
`HD1` magic header. The served per-client vault `records/public/data-<id>.enc` uses the
**lowercased client id** as its passphrase. The provider roster
`records/roster.enc` uses the provider passphrase and holds **display names only** — no clinical or
demographic data. It sits outside `records/public/` and is therefore never served (see `VAULT.md`). The served `.enc` is a **derived**
artifact, and `vault:verify` guards it against drift (see `VAULT.md`).

---

## Ingest gotchas

- **A PDF is a report, not a DEXA.** Every `.pdf` goes to the LLM report path; the
  positional DEXA parser is reached from nowhere (see above).
- **A spreadsheet nobody recognizes is queued, not guessed.** `parseRawFile` throws and the
  file becomes a pending upload rather than being parsed as a lab export.
- **DEXA parsing is layout-coupled.** A new vendor/template needs the column
  x-offsets and label strings re-derived; the symptom of a mismatch is *missing*
  markers, not an error.
- **DEXA scan date is `DD/MM/YYYY`.** A US `MM/DD/YYYY` report would mis-parse.
- **Grams in, kg/lb out.** Body-comp masses are stored unscaled in grams;
  conversion is a display concern, so the vault always holds the raw value.
- **Scale vs. DEXA markers are intentionally distinct** (`(Scale)` suffix) — do
  not merge them when summarizing a body-composition trend.
- **Blood units are canonicalized at parse time** — stored mg/dL etc., not the
  source's mmol/L, so trends are comparable across labs.
