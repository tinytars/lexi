// Extracted from ingest.ts (W80 phase 2) — pure CLI-flag parsing and help text, zero behavior change.
import { parseTreatment, parseDisease, parseDecision, parseStudy } from "./cli-parsers";
import type { DecisionEntry, DiseaseEntry, StudyEntry, TreatmentItem } from "../src/lib/types";

export interface Args {
  inputPath?: string;
  client?: string;
  needsClient: boolean;
  displayName?: string;
  dob?: string;
  gender?: "male" | "female";
  addMarkers: string[];
  removeMarkers: string[];
  addDiseases: Omit<DiseaseEntry, "id" | "pinned">[];
  removeDiseases: string[];
  clearDiseases: boolean;
  addTreatments: Omit<TreatmentItem, "id" | "pinned">[];
  removeTreatments: string[];
  clearTreatments: boolean;
  syncTreatmentAttachments: boolean;
  syncTreatmentAttachmentsName?: string;
  migrateTreatments: boolean;
  migrateCorrelations: boolean;
  migrateNotes: boolean;
  addDecisions: Omit<DecisionEntry, "id" | "pinned">[];
  removeDecisions: string[];
  clearDecisions: boolean;
  setFactors: { key: string; value: string }[];
  addStudies: Omit<StudyEntry, "id" | "pinned">[];
  clearStudies: boolean;
  removeRatios: string[];
  refreshRanges: boolean;
  refreshMarkers: string[];
  allMarkers: boolean;
  refreshFinding: boolean;
  refreshMarkerGroups: boolean;
  reportsPath?: string;
  removeSource?: string;
  processPending: boolean;
  reconcile: boolean;
  rekeyClient?: string;
  rekeyVaultClient?: string;
  backfillTreatmentAssessment: boolean;
  backfillNoteResults: boolean;
  backfillFamilyResults: boolean;
  backfillAllergyResults: boolean;
  backfillPlanAssessment: boolean;
  pruneFindingOrphans: boolean;
  dryRun: boolean;
  migrateSources: boolean;
  force: boolean;
  init: boolean;
  rebuildRoster: boolean;
  noSync: boolean;
  mode?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {
    needsClient: false,
    addMarkers: [],
    removeMarkers: [],
    addDiseases: [],
    removeDiseases: [],
    clearDiseases: false,
    addTreatments: [],
    removeTreatments: [],
    clearTreatments: false,
    syncTreatmentAttachments: false,
    migrateTreatments: false,
    migrateCorrelations: false,
    migrateNotes: false,
    addDecisions: [],
    removeDecisions: [],
    clearDecisions: false,
    setFactors: [],
    addStudies: [],
    clearStudies: false,
    removeRatios: [],
    refreshRanges: false,
    refreshMarkers: [],
    allMarkers: false,
    refreshFinding: false,
    refreshMarkerGroups: false,
    dryRun: false,
    migrateSources: false,
    processPending: false,
    reconcile: false,
    backfillTreatmentAssessment: false,
    backfillNoteResults: false,
    backfillFamilyResults: false,
    backfillAllergyResults: false,
    backfillPlanAssessment: false,
    pruneFindingOrphans: false,
    force: false,
    init: false,
    rebuildRoster: false,
    noSync: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--display-name") { out.displayName = argv[++i]; out.needsClient = true; }
    else if (a === "--dob" || a === "--set-dob") { out.dob = argv[++i]; out.needsClient = true; }
    else if (a === "--gender" || a === "--set-gender") {
      const g = argv[++i];
      if (g !== "male" && g !== "female") throw new Error(`--gender must be "male" or "female"`);
      out.gender = g;
      out.needsClient = true;
    }
    else if (a === "--add-marker") { out.addMarkers.push(argv[++i]); out.needsClient = true; }
    else if (a === "--remove-marker") { out.removeMarkers.push(argv[++i]); out.needsClient = true; }
    else if (a === "--add-disease") { out.addDiseases.push(parseDisease(argv[++i], "--add-disease")); out.needsClient = true; }
    else if (a === "--remove-disease") { out.removeDiseases.push(argv[++i]); out.needsClient = true; }
    else if (a === "--clear-diseases") { out.clearDiseases = true; out.needsClient = true; }
    else if (a === "--add-treatment") { out.addTreatments.push(parseTreatment(argv[++i], "--add-treatment")); out.needsClient = true; }
    else if (a === "--remove-treatment") { out.removeTreatments.push(argv[++i]); out.needsClient = true; }
    else if (a === "--clear-treatments") { out.clearTreatments = true; out.needsClient = true; }
    else if (a === "--sync-treatment-attachments") {
      out.syncTreatmentAttachments = true;
      out.needsClient = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.syncTreatmentAttachmentsName = argv[++i];
    }
    else if (a === "--migrate-treatments") { out.migrateTreatments = true; out.needsClient = true; }
    else if (a === "--migrate-correlations") { out.migrateCorrelations = true; out.needsClient = true; }
    else if (a === "--migrate-notes") { out.migrateNotes = true; out.needsClient = true; }
    else if (a === "--add-decision") { out.addDecisions.push(parseDecision(argv[++i], "--add-decision")); out.needsClient = true; }
    else if (a === "--remove-decision") { out.removeDecisions.push(argv[++i]); out.needsClient = true; }
    else if (a === "--clear-decisions") { out.clearDecisions = true; out.needsClient = true; }
    else if (a === "--set-factor") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--set-factor requires key=value, got "${kv}"`);
      out.setFactors.push({ key: kv.slice(0, eq), value: kv.slice(eq + 1) });
      out.needsClient = true;
    }
    else if (a === "--add-study") { out.addStudies.push(parseStudy(argv[++i], "--add-study")); out.needsClient = true; }
    else if (a === "--clear-studies") { out.clearStudies = true; out.needsClient = true; }
    else if (a === "--remove-ratio") { out.removeRatios.push(argv[++i]); out.needsClient = true; }
    else if (a === "--refresh-ranges") { out.refreshRanges = true; out.needsClient = true; }
    else if (a === "--marker") out.refreshMarkers.push(argv[++i]);
    else if (a === "--all-markers") out.allMarkers = true;
    else if (a === "--refresh-finding") { out.refreshFinding = true; out.needsClient = true; }
    else if (a === "--refresh-marker-groups" || a === "--refresh-watchlist-groups") { out.refreshMarkerGroups = true; out.needsClient = true; }
    else if (a === "--import-reports") { out.reportsPath = argv[++i]; out.needsClient = true; }
    else if (a === "--remove-source") { out.removeSource = argv[++i]; out.needsClient = true; }
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-sync") out.noSync = true;
    else if (a === "--migrate-sources") { out.migrateSources = true; out.needsClient = true; }
    else if (a === "--process-pending") { out.processPending = true; out.needsClient = true; }
    else if (a === "--reconcile") out.reconcile = true;
    else if (a === "--rekey-client") out.rekeyClient = argv[++i];
    else if (a === "--rekey-vault-client") { out.rekeyVaultClient = argv[++i]; out.needsClient = true; }
    else if (a === "--backfill-treatment-assessment") out.backfillTreatmentAssessment = true;
    else if (a === "--backfill-note-results") out.backfillNoteResults = true;
    else if (a === "--backfill-family-results") out.backfillFamilyResults = true;
    else if (a === "--backfill-allergy-results") out.backfillAllergyResults = true;
    else if (a === "--backfill-plan-assessment") out.backfillPlanAssessment = true;
    else if (a === "--prune-finding-orphans") { out.pruneFindingOrphans = true; out.needsClient = true; }
    else if (a === "--force") out.force = true;
    else if (a === "--init") out.init = true;
    else if (a === "--rebuild-roster") out.rebuildRoster = true;
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("--") && !out.inputPath) { out.inputPath = a; out.needsClient = true; }
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

export function usage(): never {
  process.stdout.write(
    `\nUsage: npm run ingest -- [xls-path] [options]\n\n` +
      `Options:\n` +
      `  --client <id>             client id (required for most ops)\n` +
      `  --display-name <name>     set client display name\n` +
      `  --set-dob YYYY-MM-DD      set date of birth (also: --dob)\n` +
      `  --set-gender male|female  set gender (also: --gender)\n` +
      `  --add-marker <marker>     add marker to client's watchlist (repeatable)\n` +
      `  --remove-marker <name>    remove marker from client's watchlist (repeatable)\n` +
      `  --add-disease "Date|Diagnostic"  add a personal disease/diagnosis row (repeatable)\n` +
      `                                   e.g. "2019|Non Alcoholic Fatty Liver Disease"\n` +
      `  --remove-disease <diagnostic>    remove all rows for this diagnostic (repeatable)\n` +
      `  --clear-diseases               drop all disease entries before --add-disease runs\n` +
      `  --add-treatment "Name|Dose|Kind|Start|End"  add a treatment row (repeatable).\n` +
      `                             Dose/Kind/End optional; Kind one of drug|supplement|behavior (default drug);\n` +
      `                             Start/End are the ISO period the treatment ran — a FUTURE Start = a planned\n` +
      `                             treatment, an End in the past = discontinued. e.g. "Tirzepatide|6mg/week||2025-08"\n` +
      `                             or "10k steps/day||behavior|2026-01" or planned "Rosuvastatin|20mg|drug|2026-09"\n` +
      `  --remove-treatment <name> remove all rows for this treatment name (repeatable)\n` +
      `  --clear-treatments        drop all treatments before --add-treatment runs\n` +
      `  --sync-treatment-attachments [name]  union attachments across sibling rows sharing a\n` +
      `                             treatment name (additive-only repair for the medicine-scope\n` +
      `                             save fan-out bug); omit [name] to sync every treatment group\n` +
      `  --migrate-treatments      one-time: fold legacy medications/supplements/plan into treatments\n` +
      `                             (ISO-normalized), then refresh the Finding\n` +
      `  --migrate-correlations    one-time: fold retired factors.correlations into noteEntries\n` +
      `                             (date embedded in the note text), then re-stamp Finding hashes\n` +
      `  --migrate-notes           one-time: fold retired factors.notes scalar into noteEntries,\n` +
      `                             then re-stamp Finding hashes\n` +
      `  --add-decision "Intervention|Purpose"  add a decision row (repeatable)\n` +
      `                                          e.g. "TRT|improved free T"\n` +
      `  --remove-decision <intervention>  remove a decision row (repeatable)\n` +
      `  --clear-decisions           drop all decisions before --add-decision runs\n` +
      `  --set-factor key=value    set a factor; key one of:\n` +
      `                            pregnancy=none|pregnant|postpartum|menopause\n` +
      `                            athletic=sedentary|moderate|endurance\n` +
      `                            smoking=never|former|current\n` +
      `                            bmi=<number>\n` +
      `                            height=<free text e.g. 176cm or 5ft 5in>\n` +
      `                            ethnicity=<string>\n` +
      `  --add-study "Focus|Detail"  add a named study tuple under Pursued Study (repeatable)\n` +
      `  --clear-studies           drop all named study tuples before --add-study runs\n` +
      `  --remove-ratio <name>     remove a Critical Ratio from the Finding by name (repeatable).\n` +
      `                            Ratios are additive on --refresh-finding (a re-run adds new\n` +
      `                            ones but never drops existing); this is the explicit removal.\n` +
      `  --refresh-ranges          regenerate personalized ranges for this client via Claude\n` +
      `  --marker <name>           with --refresh-ranges: only this marker (repeatable)\n` +
      `  --all-markers             with --refresh-ranges: every marker, not just watchlist\n` +
      `  --refresh-finding         regenerate the AI Finding (progression + disease + treatment)\n` +
      `  --refresh-marker-groups   regroup every marker by body system (System Analysis) via Claude\n` +
      `  --import-reports <path>   ingest narrative medical-report PDF(s) (a .pdf or a directory\n` +
      `                            of *.pdf) via Claude into Diagnosed Disease + imaging markers.\n` +
      `                            Per report: stores the PDF under sources/<id>/, tags entries\n` +
      `                            with a content-hash sourceId, reconciles idempotently. A PDF\n` +
      `                            already on file reuses its cached extraction (no LLM call).\n` +
      `  --dry-run                 with --import-reports: print proposals only, write nothing\n` +
      `  --remove-source <id|file> cascade-delete a source: its raw + processed files, the\n` +
      `                            SourceRecord, and every reading/disease it produced (corroborated\n` +
      `                            readings survive, re-attributed). Writes a PHI-free tombstone;\n` +
      `                            idempotent. Prints the git-history purge note (see RECOVERY.md).\n` +
      `  --no-sync                 skip the R2 pull-before / push-after (offline/local-only)\n` +
      `  --process-pending         parse + fold every browser-uploaded pending file (W15/2):\n` +
      `                            pull each raw from R2, ingest it, clear the pending entry\n` +
      `  --reconcile               R2→repo survival sync (W15/2b): pull the authoritative vault,\n` +
      `                            fold pending, materialize any missing raw + processed files,\n` +
      `                            write plaintext ONLY when content changed. Omit --client for all.\n` +
      `  --rekey-client <old>=<new>\n` +
      `                            move every R2 object of one client (vault, chat, raw, text,\n` +
      `                            processed) from <old> to <new>, copy→verify→delete per object.\n` +
      `                            Both ids are spelled out because a re-keyed roster no longer\n` +
      `                            holds the old one, so --client cannot supply it. Standalone:\n` +
      `                            it returns without running --reconcile. --dry-run lists every\n` +
      `                            key and writes nothing.\n` +
      `  --rekey-vault-client <old>=<new>\n` +
      `                            rename one entry of the clients map INSIDE --client's deployed\n` +
      `                            vault, reusing its DEK so every D1 envelope stays valid.\n` +
      `                            The companion to --rekey-client, which moves R2 keys only.\n` +
      `                            --dry-run prints the rename and writes nothing.\n` +
      `  --backfill-treatment-assessment\n` +
      `                            fill any Ongoing/Past treatment missing a LexiTar assessment or\n` +
      `                            Planned treatment missing an aiOnPlan row, calling the same\n` +
      `                            leaf-regen node the app uses. Omit --client for every client in\n` +
      `                            the roster; --dry-run prints what would be filled without calling\n` +
      `                            Anthropic or writing anything.\n` +
      `  --backfill-note-results   fill noteResults for any client with a note missing a LexiTar\n` +
      `                            result (unscoped — regenerates every note's result, same as the\n` +
      `                            app's own Translate/save trigger). Omit --client for all; --dry-run\n` +
      `                            prints what would be filled without calling Anthropic.\n` +
      `  --backfill-family-results same as --backfill-note-results, for familyResults.\n` +
      `  --backfill-allergy-results\n` +
      `                            same as --backfill-note-results, for allergyResults.\n` +
      `  --prune-finding-orphans   one-time: drop Finding entries whose source row was deleted before\n` +
      `                            deletion cascaded (vault-item-ops prunes them now). Prints what it removes.\n` +
      `  --backfill-plan-assessment\n` +
      `                            regenerate planAssessmentRows (aiOnPlan) for any client whose Patient\n` +
      `                            Plan has an action with no assessment, or an assessment for an action\n` +
      `                            no longer in the plan. One unscoped call replaces the whole section.\n` +
      `  --migrate-sources         one-time: reportId→sourceId, reports→sources, canonicalize\n` +
      `                            imaging names, move reports/→sources/ (idempotent)\n` +
      `  --force                   re-extract/re-ingest even if the source/inputs are unchanged;\n` +
      `                            with --backfill-treatment-assessment, REGENERATE every treatment\n` +
      `                            rather than only those still missing an assessment\n` +
      `  --init                    create a new empty roster (records/roster.enc) if missing\n` +
      `  --rebuild-roster          regenerate records/roster.enc from the per-client vaults\n` +
      `  --mode dev|prod           inference model tier (default prod=Opus; dev=cheapest, for iteration)\n` +
      `  -h, --help                show this help\n\n` +
      `Range and Finding refresh both require ANTHROPIC_API_KEY in the environment.\n\n` +
      `Examples:\n` +
      `  npm run ingest -- --init --client a --display-name "Client A" --dob 1980-01-01 --gender female\n` +
      `  npm run ingest -- ./client-a.xlsx --client a\n` +
      `  npm run ingest -- --client a --add-marker "Vitamin D"\n` +
      `  npm run ingest -- --client a --add-disease "2020-01|CLL" --set-factor athletic=sedentary\n\n`,
  );
  process.exit(0);
}
