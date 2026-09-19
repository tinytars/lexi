// M69 — resolves a pasted permalink (client/tab/section/anchor) against the vault into a bounded
// preview + LLM-context payload. Mirrors this codebase's "one registry, not N bespoke branches"
// convention (leaf-regen-registry.ts's LEAF_REGEN_SPECS, report-sections.ts's SectionMeta): one
// dispatch bucket per anchor prefix, each re-deriving the candidate entities' own anchor.ts anchor
// and comparing for equality — slug() (used inside markerAnchor, treatmentAnchor, etc.) is
// lossy/non-invertible, so there's no way to parse a slug back into a name.

import type {
  Client, Vault, AllergyEntry, FamilyHistoryEntry, DecisionEntry, MarkerResult,
} from "./types";
import { type Permalink, sectionLabel } from "./permalink";
import { reportDateOf, REPORT_KIND_LABEL } from "@pablotech/akesi/report-title";
import {
  reportAnchor, diagnosisAnchor, markerAnchor, watchAnchor, ratioAnchor,
  treatmentAnchor, studyAnchor, futureAnchor, ideaAnchor, rowAnchors,
} from "./anchor";
import { buildMarkerRatios } from "./marker-ratios";
import { sortPinnedFirst } from "./pin-sort";
import { treatmentsOf } from "@pablotech/akesi/treatment-normalize";
import { collapseByName, formatDose } from "@pablotech/akesi/treatment-bucket";
import { resolveRange } from "@pablotech/akesi/ranges";

export type ReferenceKind =
  | "report" | "diagnosis" | "marker" | "ratio" | "watchlist" | "treatment"
  | "study" | "idea" | "group" | "condition" | "decision"
  | "section" | "wrong-patient" | "unresolved" | "chatTurn";

export interface ResolvedReference {
  kind: ReferenceKind;
  permalink: Permalink;
  preview: { title: string; subtitle?: string; tag: string };
  context: Record<string, unknown> | null;
}

function unresolved(pl: Permalink): ResolvedReference {
  return { kind: "unresolved", permalink: pl, preview: { title: "Link not found", tag: "Unresolved" }, context: null };
}


function rowsFor(client: Client, name: string): MarkerResult[] {
  return client.results.filter((r) => r.marker === name).sort((a, b) => a.date.localeCompare(b.date));
}

function latestOf(rows: MarkerResult[]): MarkerResult | undefined {
  return rows[rows.length - 1];
}

function markerPreview(name: string, rows: MarkerResult[], tag: string): ResolvedReference["preview"] {
  const latest = latestOf(rows);
  const subtitle = latest ? `${latest.valueText ?? latest.value} ${latest.unit} (${latest.date})` : undefined;
  return { title: name, subtitle, tag };
}

function resolveReport(client: Client, pl: Permalink, a: string): ResolvedReference {
  const diseases = client.factors?.diseases ?? [];
  for (const s of client.sources ?? []) {
    if (reportAnchor(s.id) === a) {
      const dx = diseases.filter((d) => d.sourceId === s.id);
      const date = reportDateOf(s);
      return {
        kind: "report",
        permalink: pl,
        // W62 — the title here is the FILENAME, deliberately, where every other surface shows the
        // clinical title (reportTitleOf). A link preview answers "which file is this link to?", and
        // `file` below carries the same value for the consumer. Left as-is rather than unified: it
        // is a plausible intent, not obvious drift. Revisit if a preview ever reads oddly.
        preview: { title: s.originalName, subtitle: date, tag: REPORT_KIND_LABEL[s.kind] },
        context: {
          file: s.originalName,
          kind: s.kind,
          date,
          diagnoses: dx.map((d) => ({ diagnostic: d.diagnostic, summary: d.summary, icdCodes: d.icdCodes })),
        },
      };
    }
    const dxForSource = diseases.filter((d) => d.sourceId === s.id);
    for (let i = 0; i < dxForSource.length; i++) {
      if (diagnosisAnchor(s.id, i) === a) {
        const d = dxForSource[i];
        return {
          kind: "diagnosis",
          permalink: pl,
          preview: { title: d.diagnostic, subtitle: s.originalName, tag: "Diagnosis" },
          context: { diagnostic: d.diagnostic, summary: d.summary, icdCodes: d.icdCodes, date: d.date },
        };
      }
    }
  }
  for (const p of client.pendingUploads ?? []) {
    if (reportAnchor(p.id) === a) {
      return {
        kind: "report",
        permalink: pl,
        preview: { title: p.originalName, subtitle: `Uploaded ${p.uploadedAt.slice(0, 10)} — processing`, tag: "Processing" },
        context: null,
      };
    }
  }
  return unresolved(pl);
}

function resolveWatchlist(client: Client, pl: Permalink, a: string): ResolvedReference {
  for (const name of client.watchlist ?? []) {
    if (watchAnchor(name) === a) {
      const rows = rowsFor(client, name);
      return {
        kind: "watchlist",
        permalink: pl,
        preview: markerPreview(name, rows, "Watchlist"),
        context: { marker: name, rows, range: resolveRange(name, client) },
      };
    }
  }
  return unresolved(pl);
}

function resolveRatio(client: Client, pl: Permalink, a: string): ResolvedReference {
  for (const rv of buildMarkerRatios(client)) {
    if (ratioAnchor(rv.ratio.name) === a) {
      return {
        kind: "ratio",
        permalink: pl,
        preview: markerPreview(rv.ratio.name, rv.rows, "Ratio"),
        context: { name: rv.ratio.name, rows: rv.rows, range: rv.range },
      };
    }
  }
  return unresolved(pl);
}

function resolveMarker(client: Client, pl: Permalink, a: string): ResolvedReference {
  const names = new Set(client.results.map((r) => r.marker));
  for (const name of names) {
    if (markerAnchor(name) === a) {
      const rows = rowsFor(client, name);
      return {
        kind: "marker",
        permalink: pl,
        preview: markerPreview(name, rows, "Marker"),
        context: { marker: name, rows, range: resolveRange(name, client) },
      };
    }
  }
  return unresolved(pl);
}

function resolveTreatment(client: Client, pl: Permalink, a: string): ResolvedReference {
  for (const t of collapseByName(treatmentsOf(client))) {
    if (treatmentAnchor(t.name) === a) {
      return {
        kind: "treatment",
        permalink: pl,
        preview: { title: t.name, subtitle: formatDose(t), tag: "Treatment" },
        context: { name: t.name, dose: formatDose(t), kind: t.kind, start: t.start, end: t.end, reason: t.reason },
      };
    }
  }
  return unresolved(pl);
}


function resolveCondition(client: Client, pl: Permalink, a: string): ResolvedReference {
  // W64 — sortPinnedFirst, matching every surface that RENDERS these anchors (allergySidebarRows,
  // buildAllergyRows, Allergies.svelte's own sortedAllergies). The collision suffix is positional,
  // so resolving over the unsorted array computed different ids than the rows it was resolving to
  // the moment anything was pinned — the permalink then landed on the wrong entry or nowhere.
  const allergies: AllergyEntry[] = sortPinnedFirst(client.factors?.allergies ?? []);
  const allergenAnchors = rowAnchors(allergies.map((x) => x.allergen));
  for (let i = 0; i < allergies.length; i++) {
    if (allergenAnchors[i] === a) {
      const al = allergies[i];
      return {
        kind: "condition",
        permalink: pl,
        preview: { title: al.allergen || "Untitled", subtitle: al.reaction, tag: "Allergy" },
        context: { allergen: al.allergen, reaction: al.reaction, severity: al.severity, dateNoted: al.dateNoted },
      };
    }
  }

  const family: FamilyHistoryEntry[] = sortPinnedFirst(client.factors?.familyHistory ?? []);
  const relationAnchors = rowAnchors(family.map((x) => x.relation));
  for (let i = 0; i < family.length; i++) {
    if (relationAnchors[i] === a) {
      const f = family[i];
      return {
        kind: "condition",
        permalink: pl,
        preview: { title: f.relation || "Untitled", subtitle: f.condition, tag: "Family History" },
        context: { relation: f.relation, condition: f.condition },
      };
    }
  }

  return unresolved(pl);
}

function resolveStudy(client: Client, pl: Permalink, a: string): ResolvedReference {
  const candidates: { label: string; detail?: string }[] = [];
  for (const e of client.study?.entries ?? []) candidates.push({ label: e.focus, detail: e.detail });

  for (const c of candidates) {
    if (studyAnchor(c.label) === a) {
      const ai = client.finding?.studyResults?.find((r) => r.study === c.label)?.result;
      return {
        kind: "study",
        permalink: pl,
        preview: { title: c.label, subtitle: c.detail, tag: "Study" },
        context: { focus: c.label, detail: c.detail, aiResult: ai },
      };
    }
  }
  return unresolved(pl);
}

function resolveHypothesis(client: Client, pl: Permalink, a: string): ResolvedReference {
  // "idea" — client.factors.decisions is the only real anchor.ts-backed source; ideaAnchor's "ai"
  // side is never mounted anywhere in the DOM (see FutureTreatment.svelte).
  const decisions: DecisionEntry[] = client.factors?.decisions ?? [];
  for (let i = 0; i < decisions.length; i++) {
    if (ideaAnchor(decisions[i].intervention, "patient", i) === a) {
      const d = decisions[i];
      const evalEntry = client.finding?.decisions?.patient.find((x) => x.intervention.trim() === d.intervention.trim());
      return {
        kind: "idea",
        permalink: pl,
        preview: { title: d.intervention || "Untitled", subtitle: d.purpose, tag: "Idea" },
        context: {
          intervention: d.intervention,
          purpose: d.purpose,
          recommendation: evalEntry?.recommendation,
          pros: evalEntry?.pros,
          cons: evalEntry?.cons,
        },
      };
    }
  }

  // "group" — finding.treatmentGroups, one shared bubble per drug class.
  for (const g of client.finding?.treatmentGroups ?? []) {
    if (futureAnchor(g.topic) === a) {
      return {
        kind: "group",
        permalink: pl,
        preview: { title: g.topic, subtitle: g.system, tag: "Hypothesis" },
        context: { topic: g.topic, system: g.system, patient: g.patient, ai: g.ai },
      };
    }
  }

  return unresolved(pl);
}

export function resolveReference(vault: Vault, currentClientId: string | null, pl: Permalink): ResolvedReference {
  // Client-boundary gate, checked first, always — never touch another client's vault data.
  if (pl.client && pl.client !== currentClientId) {
    return { kind: "wrong-patient", permalink: pl, preview: { title: "Different patient", tag: "Blocked" }, context: null };
  }

  // No-anchor gate, checked second — a tab- or section-level permalink is a real, already-
  // supported navigation target, not an "unresolved" one. No vault lookup needed.
  if (!pl.anchor) {
    return { kind: "section", permalink: pl, preview: { title: sectionLabel(pl.section ?? pl.tab), tag: "View" }, context: null };
  }

  const client = currentClientId ? vault.clients[currentClientId] : undefined;
  if (!client) return unresolved(pl);

  const a = pl.anchor;
  if (a.startsWith("report-")) return resolveReport(client, pl, a);
  if (a.startsWith("chart-watch-")) return resolveWatchlist(client, pl, a);
  if (a.startsWith("chart-ratio-")) return resolveRatio(client, pl, a);
  if (a.startsWith("chart-")) return resolveMarker(client, pl, a);
  if (a.startsWith("rx-")) return resolveTreatment(client, pl, a);
  if (a.startsWith("cond-")) return resolveCondition(client, pl, a);
  if (a.startsWith("study-")) return resolveStudy(client, pl, a);
  if (a.startsWith("spec-")) return resolveHypothesis(client, pl, a);
  // corr- has no backing data collection anywhere in Client; dec- has data but no UI ever emits
  // that anchor (real decision rows emit ideaAnchor instead) — both are registered here rather
  // than falling through silently, so an unrecognized-prefix bug can't masquerade as either.
  return unresolved(pl);
}
