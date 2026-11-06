<script lang="ts" module>
  import type { Client, Attachment, TreatmentItem } from "./types";
  import { collapseByName, groupByName, bucketOf, assessmentFor, treatmentMeta, treatmentLabel, todayISODate, BUCKET_LABEL, type Bucket } from "@pablotech/akesi/treatment-bucket";
  import { groupBucket, partitionGroupsByBucket } from "./treatment-sidebar";
  import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
  import { planActionSystems } from "./treatment-groups";
  import { attachmentsOf, attachmentUrl } from "./attachment-store";

  export interface Row { name: string; dose?: string; meta?: string; assessment?: string; group?: string; attachments: Attachment[]; bucket: Bucket }

  // Shared with UnifiedTreatment.svelte's own read (patient) model and SearchPanel's treatment
  // resolver, so both build the exact same collapsed/bucketed/AI-matched rows from one source of
  // truth — collapsed by name, grouped by system, AI assessment matched with a used-set so one
  // assessment never double-attributes to two same-named rows.
  // One drug, one phase, several rows. assessmentFor matches a stored entry by id FIRST, and its
  // name fallback deliberately refuses an entry id-keyed to a DIFFERENT row — so asking with one
  // guessed representative finds nothing whenever the entry was written against another of the
  // drug's rows in the same phase, which is every titrated drug. Ask row by row and keep the first
  // hit; a miss consumes nothing from `used`, so walking past a row cannot spend another drug's
  // entry on the way.
  function assessmentOfRows(client: Client, rows: TreatmentItem[], phase: Bucket, used: Set<object>) {
    for (const r of rows) {
      const hit = assessmentFor(client.finding, r.name, phase, used, r.id);
      if (hit) return hit;
    }
    return undefined;
  }

  export function buildTreatmentRows(client: Client): { ongoing: Row[]; planned: Row[]; past: Row[] } {
    const today = todayISODate();
    // Drug-level buckets (2026-11-06). This read partitionByBucket(collapseByName(...)): one
    // collapsed representative per drug, bucketed as though it were a dose period. A single
    // representative cannot encode a drug that has a current period AND a future one —
    // collapseByName takes the EARLIEST start and carries an end only if the newest-start row has
    // one — so a morning row left open while the evening row was closed out read as finished, and a
    // drug taken years ago and scheduled to resume read as current. groupBucket reads all of a
    // drug's rows, which is what the editable card and the sidebar file it under too, so this
    // read-only view, the search preview and the three filters can no longer disagree.
    //
    // Sorted by name up front because groupByName's own primary key is the newest-START row's
    // bucket, a different question from groupBucket's: inside one bucket that would scatter the
    // list for a reason nobody reading it could see. collapseByName sorted by name, so this is the
    // order these three lists have always had.
    const groups = [...groupByName(treatmentsOf(client), today)].sort((a, b) => a.name.localeCompare(b.name));
    const byBucket = partitionGroupsByBucket(groups, today);

    // assessmentFor, not a private matcher: this file used to carry its own two-tier lookup for
    // ongoing and a STRICT Map.get for planned — the exact bug fixed in the card, left live here, so
    // a planned drug whose assessment is stored under its bare name showed nothing in the read-only
    // and search views. One drug can now also hold three assessments, one per phase.
    const used = new Set<object>();
    const rowsFor = (bucket: Bucket): Row[] =>
      byBucket[bucket].map((g) => {
        // The drug's rows that are themselves in its bucket. Never empty: groupBucket returns
        // ongoing or planned only when a row of that kind is present, and past only when every row
        // is past.
        const inBucket = g.rows.filter((r) => bucketOf(r, today) === bucket);
        // The collapsed representative still supplies the DISPLAY fields — latest dose, latest
        // attachments — and collapsing one drug's rows gives the same item it gave over the whole
        // list. The dates are the exception: its start is the drug's earliest, which for a planned
        // drug renders "planned for <the date it was first taken>", years in the past. Use the
        // EARLIEST row of the planned block instead (g.rows is newest-first), the date the drug
        // actually resumes. ongoing's "since <earliest start>" and past's full range are right as
        // they are.
        const collapsed = collapseByName(g.rows)[0];
        const rep = bucket === "planned" ? (inBucket[inBucket.length - 1] ?? collapsed) : collapsed;
        const hit = assessmentOfRows(client, inBucket, bucket, used);
        return {
          name: collapsed.name,
          dose: collapsed.dose,
          meta: treatmentMeta(rep, bucket),
          attachments: attachmentsOf(collapsed),
          bucket,
          assessment: hit?.assessment,
          // planActionSystems keys on a planned ROW's own treatmentLabel (name + dose), so the
          // representative has to be that row and not the collapsed item, whose dose is the
          // newest row's.
          group: hit?.group ?? (bucket === "planned" ? planActionSystems(client).get(treatmentLabel(rep)) : undefined),
        };
      });

    const ongoing = rowsFor("ongoing");
    const planned = rowsFor("planned");
    const past = rowsFor("past");
    return { ongoing, planned, past };
  }
</script>

<script lang="ts">
  import TurnCard from "./TurnCard.svelte";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import { treatmentAnchor } from "./anchor";
  import { PRODUCT_NAME } from "./brand";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";

  // M91 Phase 3 — extracted from UnifiedTreatment.svelte's private `treatmentRow` snippet (the
  // read-only/patient view; the editable provider row stays as UnifiedTreatment's own `provRow`
  // snippet, unextracted, since search previews are always read-only). `onOpen` is set only by
  // the search preview (mirrors MarkerChart's "Details" action) — the home tab omits it, which
  // also means the card renders no header row at all there, matching pre-extraction behavior.
  // M102 Phase 1 — the Ungrouped view concatenates all three buckets with no other visual
  // distinction (the bucketed views imply status by which section they're in); showBucket is
  // true only from those Ungrouped call sites.
  // `showAi` is gone: every call site passed true, so its collapse branch was dead code. Both
  // halves of a turn always render now, with an empty state when one is absent.
  interface Props { row: Row; showBucket?: boolean; clientId?: string | null; onOpen?: () => void }
  let { row: r, showBucket = false, clientId = null, onOpen }: Props = $props();
</script>

<!-- No `anchor` on the card: the drug's HeadingAnchor lives inside the patient bubble (it always
     has), and giving the card the same id would put that id in the DOM twice — the first one wins
     for getElementById, so scroll-to would land on the wrong element. -->
<TurnCard
  {onOpen}
  patient={patientTurn}
  patientMeta={r.meta}
  ai={r.assessment ? aiTurn : undefined}
  aiEmpty={`No ${PRODUCT_NAME} assessment.`}
/>

{#snippet patientTurn()}
  <div class="ct-title-row">
    <div class="ct-drug"><HeadingAnchor anchor={treatmentAnchor(r.name)} label="Copy link to this treatment">{r.name}</HeadingAnchor></div>
    {#if showBucket}<span class="bucket bucket--{r.bucket}">{BUCKET_LABEL[r.bucket]}</span>{/if}
  </div>
  {#if r.dose}<p class="ct-dose">{r.dose}</p>{/if}
  <AttachmentStrip attachments={r.attachments} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
{/snippet}

{#snippet aiTurn()}<p class="ct-assess">{r.assessment}</p>{/snippet}

<style>
  .ct-title-row { display: flex; align-items: baseline; gap: 0.45rem; }
  .ct-drug { font-weight: 600; font-size: 0.92rem; color: var(--fg); }
  .ct-dose { margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--muted); }
  .ct-assess { margin: 0; font-size: 0.86rem; line-height: 1.45; color: var(--fg); }
  .bucket { display: inline-block; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .bucket--ongoing { background: var(--band); color: var(--accent); }
  .bucket--planned { background: var(--warn-band); color: var(--warn); }
  .bucket--past { background: var(--border); color: var(--muted); }
</style>
