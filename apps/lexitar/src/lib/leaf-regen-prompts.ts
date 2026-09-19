import { dagNode } from "./finding-dag";
import { CURRENT_DOSE_RULE, CO_MENTION_RULE, BUCKET_DOSE_RULE, STANDARD_DOSING_RULE } from "@pablotech/akesi/treatment-timing-rules";

// Each prompt's clinical reasoning is vault-authored (finding-dag/<node>.md `## Reasoning`, via dagNode); only the plumbing around it lives here.

// Kept apart from the Anthropic call so brain-source.ts can hash it without importing the SDK.
export const BASE_SYSTEM_PROMPT =
  "You are regenerating a single leaf section of a patient's health Finding, from exactly the " +
  "upstream context supplied below — not the whole Finding. Emit the result ONLY through the " +
  "provided tool.";

export const HYPOTHESIS_EVALUATION_TOOL = {
  name: "emit_hypothesis_evaluation",
  description: "Emit the AI's pros/cons/alternatives/recommendation evaluation of each patient hypothesis entry.",
  input_schema: {
    type: "object" as const,
    properties: {
      patient: {
        type: "array",
        description: "One entry per patientHypothesis intervention, same order, one-to-one.",
        items: {
          type: "object",
          properties: {
            intervention: { type: "string", description: "copied verbatim from the patientHypothesis entry" },
            purpose: { type: "string", description: "copied verbatim from the patientHypothesis entry" },
            pros: { type: "array", items: { type: "string" }, description: "3–6 short bullets, each ≤30 words" },
            cons: { type: "array", items: { type: "string" }, description: "3–6 short bullets, each ≤30 words" },
            alternatives: { type: "array", items: { type: "string" }, description: "2–5 short bullets, each ≤40 words" },
            recommendation: { type: "string", description: "3–6 sentences of plain prose" },
            questions: {
              type: "array",
              items: { type: "string" },
              description:
                "2–4 short bullets (5–25 words each) the patient should literally raise with their doctor about THIS intervention, drawn from the pros/cons/alternatives/recommendation above",
            },
          },
          required: ["intervention", "purpose", "pros", "cons", "alternatives", "recommendation", "questions"],
        },
      },
    },
    required: ["patient"],
  },
};

export const HYPOTHESIS_EVALUATION_SYSTEM_PROMPT =
  "You evaluate each intervention the patient is weighing (patientHypothesis) with pros, cons, " +
  "alternatives, and a recommendation, grounded in the AI Findings (aiFindings) and the AI's own " +
  "proposed intervention set (aiHypothesis) supplied below. Emit exactly one entry per patientHypothesis " +
  "item, same order, copying its intervention and purpose verbatim — do not invent or drop entries. " +
  `${dagNode("hypothesisEvaluation")?.reasoning} ` +
  "Emit the result ONLY through the emit_hypothesis_evaluation tool.";

export const AI_ON_PLAN_TOOL = {
  name: "emit_plan_assessment_rows",
  description: "Emit the AI's assessment of each Patient Plan action.",
  input_schema: {
    type: "object" as const,
    properties: {
      rows: {
        type: "array",
        description: "One entry per patientPlan action, same order, one-to-one.",
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "copied verbatim from the patientPlan action's name — WITHOUT any timing prefix" },
            assessment: { type: "string", description: "1–2 sentences on THAT specific action" },
          },
          required: ["action", "assessment"],
        },
      },
    },
    required: ["rows"],
  },
};

export const AI_ON_PLAN_SYSTEM_PROMPT =
  "You assess each action in the patient's Patient Plan (patientPlan) individually, grounded in the " +
  "patient's overall profile (patientAssessment), lab markers (markerLevels), AI Findings (aiFindings), " +
  "and the current hypothesis evaluation (hypothesisEvaluation) supplied below. Emit exactly one entry " +
  "per patientPlan action, same order, copying its action text verbatim (WITHOUT any timing prefix) — do " +
  "not invent or drop entries. " +
  `${dagNode("aiOnPlan")?.reasoning} ` +
  CO_MENTION_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "This action has NOT started yet, so another treatment is concurrent with it only if that treatment " +
  "is still active at THIS action's start date — one that ends before then is a predecessor, not a " +
  "companion, and must not be described as running alongside it. If patientPlan is " +
  "empty, return an empty rows array. Emit the result ONLY through the emit_plan_assessment_rows tool.";

export const TREATMENT_ASSESSMENT_TOOL = {
  name: "emit_treatment_assessment",
  description: "Emit the AI's assessment of each current treatment item (medication or supplement).",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "One entry per (medication/supplement, phase) — drugs before supplements. A drug with past, ongoing and planned rows gets three entries.",
        items: {
          type: "object",
          properties: {
            treatmentId: {
              type: "string",
              description: "the `id` of the treatment this entry is about, copied EXACTLY from the treatmentHistory entry you are assessing",
            },
            item: { type: "string", description: "the drug or supplement name with the dose for THIS phase, copied verbatim" },
            phase: {
              type: "string",
              enum: ["past", "ongoing", "planned"],
              description: "which slice of this drug's history the assessment is about — one entry per phase the drug actually has",
            },
            assessment: { type: "string", description: "2–4 sentences of plain prose about THAT phase only" },
            group: { type: "string", description: "the body system this treatment addresses — copied VERBATIM from one of the disease[].group names" },
          },
          required: ["item", "phase", "assessment", "group"],
        },
      },
    },
    required: ["items"],
  },
};

// Its DATE AWARENESS block mirrors finding-generate.ts's so a leaf regen doesn't regress against the monolith.
export const TREATMENT_ASSESSMENT_SYSTEM_PROMPT =
  "You reassess the `assessment` prose for each current treatment item, grounded in the patient's " +
  "overall profile (patientAssessment), lab markers (markerLevels), the full current treatment list " +
  "(treatmentHistory), and the AI Findings disease decomposition (aiFindings) supplied below. Walk " +
  "every medication first, then every supplement — drugs before supplements, no mixing. Within each " +
  "block, order items by their relation to the disease findings above: the item tied to the " +
  "highest-severity / most acute finding comes first, the item tied to the weakest or absent finding " +
  "comes last. " +
  "ONE ENTRY PER (DRUG, PHASE). The treatment list carries the same drug on multiple rows when its " +
  "dose was titrated — each row is a dose change with its own dates, not a separate medication. " +
  "Group those rows by drug name (case-insensitive, ignoring dose), then split each drug's rows by " +
  "PHASE: rows whose window has ended are `past`, the row whose window contains Today is `ongoing`, " +
  "rows starting after Today are `planned`. Emit ONE entry per phase that drug actually has, and set " +
  "`phase` accordingly — so a drug that was titrated, is being taken now, and has a scheduled " +
  "increase yields THREE entries, each about its own phase only. Emit no entry for a phase the drug " +
  "does not have. Never emit two entries with the same drug name AND the same phase. " +
  "This is what lets a Past card be written purely in the past tense while the Ongoing card for the " +
  "same drug speaks about the present: they are different entries, not one text shown twice. " +
  "For each entry: item: the drug or supplement name with the dose that applies to THAT phase — the " +
  "current dose for `ongoing`, the final dose reached for `past`, the scheduled dose for `planned`. " +
  CURRENT_DOSE_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "(e.g. \"Ezetimibe 10 mg\", " +
  "\"Micronized Progesterone 15 mg\"). Use the exact spelling and casing of the drug name and the dose " +
  "string verbatim from that row; do not invent dose. Do not annotate the name with category — " +
  "drug-vs-supplement is conveyed by ordering. group: the body system this treatment addresses — " +
  "copied VERBATIM from one of the disease[].group names in aiFindings above (e.g. \"Cardiovascular " +
  "Risk\", \"Body Composition\", \"Hormonal / Endocrine\"). Every treatment group MUST be one of the " +
  "disease groups; assign each item to the system its therapy most directly targets. " +
  `${dagNode("treatmentAssessment")?.reasoning} ` +
  "A treatment row's `dailyTotal`, when present, is the already-computed daily ingredient amount " +
  "summed across every currently-ongoing row of that medicine (an AM row and a PM row both count) " +
  "— use it directly for any dose/ingredient-adequacy read and never re-derive one yourself by " +
  "multiplying an ingredient's label amount; when `dailyTotal` is absent, do not estimate one. " +
  CO_MENTION_RULE + " " +
  "If the patient has no current medications and no current supplements, emit a single entry " +
  "{ item: \"Current regimen\", assessment: \"...\", group: <the disease group the note most relates " +
  "to, or the first disease group if none fits better> } that notes the absence in one sentence and " +
  "suggests what to discuss with the physician given the disease findings above. " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins " +
  "with a `Today:` line carrying the current date, and every medication / supplement row in the " +
  "treatment list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active " +
  "dose for that row. • A closed range (e.g. [April–May 2026]) — this dose was active only " +
  "during that window. A row in this shape is a PRIOR dose level in a titration sequence; the row " +
  "with [Since Y] for the same drug is the current dose. A marker reading can only reflect a " +
  "treatment's effect if the reading was DRAWN DURING THE WINDOW the dose was active. For ongoing " +
  "rows that means the reading date must be after the \"Since X\" date; for closed ranges it means " +
  "the reading date must fall inside the range. Before you write any sentence of the form \"X has " +
  "produced effect Y\", or \"the dose increase is showing up as Z\", check explicitly: 1. Which row " +
  "of the titration is the CURRENT dose? " +
  CURRENT_DOSE_RULE + " " +
  BUCKET_DOSE_RULE + " " +
  STANDARD_DOSING_RULE + " " +
  "2. What is the date the current dose started " +
  "(the X in [Since X])? 3. What " +
  "is the date of the latest reading for the marker(s) you are about to credit to the treatment? " +
  "4. If the latest reading PRE-DATES the current dose's start, the reading CANNOT reflect that " +
  "current dose's effect — do not attribute. Say so plainly instead: \"the latest [marker] reading " +
  "[date] pre-dates the [drug] titration to [dose] [since-date], so the current dose has not been " +
  "re-tested yet; recheck in 8–12 weeks\". 5. If the latest reading is AFTER the current dose's start " +
  "but by an amount too short to expect an effect (e.g. < 2–4 weeks for most lab markers, < 8 weeks " +
  "for HbA1c, < 12 weeks for body composition), say so plainly — the dose is too new to assess yet. " +
  "6. When a reading falls within a closed-range row's window, you may attribute the effect at THAT " +
  "historical dose, not the current one. Do not make up effects that the timeline does not support. " +
  "Emit the result ONLY through the emit_treatment_assessment tool.";

export const STUDY_RESULTS_TOOL = {
  name: "emit_study_results",
  description: "Emit the AI's answer for each populated Pursued Study row, tagged to a body system.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "One entry per populated Pursued Study row, in named-tuple order.",
        items: {
          type: "object",
          properties: {
            study: { type: "string", description: "the row label verbatim — the named study tuple's focus, copied exactly as the row is labelled in the Proposed Study block" },
            result: { type: "string", description: "4–7 sentences of plain prose" },
            group: { type: "string", description: "the body system this study line belongs to — copied VERBATIM from one of the disease[].group names" },
          },
          required: ["study", "result", "group"],
        },
      },
    },
    required: ["items"],
  },
};

export const STUDY_RESULTS_SYSTEM_PROMPT =
  "You answer each populated row of the patient's Pursued Study (pursuedStudy), grounded in the " +
  "patient's overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings " +
  "disease decomposition (aiFindings) supplied below. The Proposed Study block can carry any number " +
  "of named study tuples (e.g. Effect, Presence, Synergy, Selection). Emit ONE entry for EACH line " +
  "present, in the order they appear. If the Proposed Study block " +
  "is absent or empty, return an empty items array. " +
  "For each entry: study: the row label verbatim — the named tuple's " +
  "focus (e.g. \"Effect\", \"Presence\", \"Synergy\"). Copy it exactly as the row is labelled in the " +
  "Proposed Study block. " +
  `${dagNode("studyResults")?.reasoning} ` +
  "group: the body " +
  "system this study line belongs to — copied VERBATIM from one of the disease[].group names in " +
  "aiFindings above (e.g. \"Cardiovascular Risk\", \"Hormonal / Endocrine\"). Pick the system the study " +
  "most directly concerns. Every studyResults group MUST be one of the disease groups — the UI renders " +
  "the study lines under body-system headings in disease order. (Still emit the entries in study-row " +
  "order — the group tag, not array order, drives the headings.) " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins with " +
  "a `Today:` line carrying the current date, and every medication / supplement row in the treatment " +
  "list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active dose for " +
  "that row. • A closed range (e.g. [April–May 2026]) — this dose was active only during that window. " +
  "A row in this shape is a PRIOR dose level in a titration sequence; the row with [Since Y] for the " +
  "same drug is the current dose. A marker reading can only reflect a treatment's effect if the " +
  "reading was DRAWN DURING THE WINDOW the dose was active. For ongoing rows that means the reading " +
  "date must be after the \"Since X\" date; for closed ranges it means the reading date must fall " +
  "inside the range. Before you write any sentence of the form \"X has produced effect Y\", or \"the " +
  "dose increase is showing up as Z\", check explicitly: 1. Which row of the titration is the CURRENT " +
  "dose? It is the row whose window CONTAINS Today — start on or before Today, and either no end or an " +
  "end on or after Today. A [Since X] row whose X is in the FUTURE is a scheduled step, not the present, " +
  "and a closed range that spans Today IS the present; do not assume the newest row is the current one. " +
  "2. What is " +
  "the date the current dose started (the X in [Since X])? 3. What is the date of the latest reading " +
  "for the marker(s) you are about to credit to the treatment? 4. If the latest reading PRE-DATES the " +
  "current dose's start, the reading CANNOT reflect that current dose's effect — do not attribute. Say " +
  "so plainly instead: \"the latest [marker] reading [date] pre-dates the [drug] titration to [dose] " +
  "[since-date], so the current dose has not been re-tested yet; recheck in 8–12 weeks\". 5. If the " +
  "latest reading is AFTER the current dose's start but by an amount too short to expect an effect " +
  "(e.g. < 2–4 weeks for most lab markers, < 8 weeks for HbA1c, < 12 weeks for body composition), say " +
  "so plainly — the dose is too new to assess yet. 6. When a reading falls within a closed-range row's " +
  "window, you may attribute the effect at THAT historical dose, not the current one. Do not make up " +
  "effects that the timeline does not support. Emit the result ONLY through the emit_study_results tool.";

// The id-keyed row leaves echo each row's opaque id back, because their content (an allergen, "Mother") is not unique.
function idRowTool(name: string, rowNoun: string, contextKey: string, idField: string) {
  return {
    name,
    description: `Emit the AI's response to each ${rowNoun}, tagged to a body system.`,
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: `One entry per ${contextKey} entry. Each entry carries the id of the row it answers, so order does not matter.`,
          items: {
            type: "object",
            properties: {
              [idField]: { type: "string", description: `copied VERBATIM from the "id" field of the ${rowNoun} this entry answers` },
              result: { type: "string", description: "3–6 sentences of plain prose" },
              group: { type: "string", description: `the body system this ${rowNoun} most directly concerns — copied VERBATIM from one of the disease[].group names` },
            },
            required: [idField, "result", "group"],
          },
        },
      },
      required: ["items"],
    },
  };
}

function idEchoRule(contextKey: string, idField: string): string {
  return (
    `Emit ONE entry for EACH ${contextKey} entry present. On every entry set "${idField}" to that row's ` +
    `"id" value, copied VERBATIM — that is how your answer is matched back to its row. An entry whose ` +
    `${idField} is missing, invented, or repeated, or a row left unanswered, rejects the whole response. ` +
    `Order does not matter; the id does. If ${contextKey} is empty, return an empty items array. `
  );
}

export const NOTE_RESULTS_TOOL = idRowTool("emit_note_results", "populated Note", "pursuedNotes", "noteId");

export const NOTE_RESULTS_SYSTEM_PROMPT =
  "You respond to each populated Note (pursuedNotes) — the patient's free-text jottings ahead of a " +
  "visit — grounded in the patient's overall profile (patientAssessment), lab markers (markerLevels), " +
  "and the AI Findings disease decomposition (aiFindings) supplied below. " +
  idEchoRule("pursuedNotes", "noteId") +
  "For each entry: " +
  `${dagNode("noteResults")?.reasoning} ` +
  "group: the body system this " +
  "note most directly concerns — copied VERBATIM from one of the disease[].group names in aiFindings " +
  "above. Every noteResults group MUST be one of the disease groups. " +
  "DATE AWARENESS — Read carefully before attributing any marker change. The user message begins with " +
  "a `Today:` line carrying the current date, and every medication / supplement row in the treatment " +
  "list carries a date string in square brackets. The date string is one of two shapes: " +
  "• \"Since X\" (e.g. [Since August 2025]) — treatment is ONGOING from X. This is the active dose for " +
  "that row. • A closed range (e.g. [April–May 2026]) — this dose was active only during that window. " +
  "A row in this shape is a PRIOR dose level in a titration sequence; the row with [Since Y] for the " +
  "same drug is the current dose. A marker reading can only reflect a treatment's effect if the " +
  "reading was DRAWN DURING THE WINDOW the dose was active. Before crediting any effect, check: is the " +
  "latest reading for the marker in question dated AFTER the current dose's start (or inside a closed " +
  "range's window)? If the latest reading PRE-DATES the current dose's start, say so plainly instead " +
  "of inventing an effect. If the latest reading is too soon after the dose change to expect an effect, " +
  "say so plainly — the dose is too new to assess yet. Do not make up effects the timeline does not " +
  "support. Emit the result ONLY through the emit_note_results tool.";

export const ALLERGY_RESULTS_TOOL = idRowTool("emit_allergy_results", "known allergy", "patientAllergies", "allergyId");

export const ALLERGY_RESULTS_SYSTEM_PROMPT =
  "You respond to each of the patient's known allergies (patientAllergies), grounded in the patient's " +
  "overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings disease " +
  "decomposition (aiFindings) supplied below. " +
  idEchoRule("patientAllergies", "allergyId") +
  "For each entry: " +
  `${dagNode("allergyResults")?.reasoning} ` +
  "group: the body system this allergy most directly concerns — copied VERBATIM " +
  "from one of the disease[].group names in aiFindings above; if none is a genuine fit, pick the " +
  "closest one without inventing a rationale for the fit in the result text. Every allergyResults " +
  "group MUST be one of the disease groups. Emit the result ONLY through the emit_allergy_results tool.";

export const FAMILY_RESULTS_TOOL = idRowTool("emit_family_results", "family history entry", "patientFamilyHistory", "familyId");

export const FAMILY_RESULTS_SYSTEM_PROMPT =
  "You respond to each of the patient's family history entries (patientFamilyHistory), grounded in " +
  "the patient's overall profile (patientAssessment), lab markers (markerLevels), and the AI Findings " +
  "disease decomposition (aiFindings) supplied below. " +
  idEchoRule("patientFamilyHistory", "familyId") +
  "For each entry: " +
  `${dagNode("familyResults")?.reasoning} ` +
  "group: the body system this family history entry most directly concerns — copied VERBATIM from " +
  "one of the disease[].group names in aiFindings above; if none is a genuine fit, pick the closest " +
  "one without inventing a rationale for the fit in the result text. Every familyResults group MUST " +
  "be one of the disease groups. Emit the result ONLY through the emit_family_results tool.";

export const DISEASE_RESULTS_TOOL = idRowTool("emit_disease_results", "diagnosis on file", "diagnosedDisease", "diseaseId");

export const DISEASE_RESULTS_SYSTEM_PROMPT =
  "You respond to each diagnosis on file (diagnosedDisease), grounded in the patient's overall " +
  "profile (patientAssessment), lab markers (markerLevels), and the AI Findings disease " +
  "decomposition (aiFindings) supplied below. " +
  idEchoRule("diagnosedDisease", "diseaseId") +
  "For each entry: " +
  `${dagNode("diseaseResults")?.reasoning} ` +
  "group: the body system this diagnosis most directly concerns — copied VERBATIM from one " +
  "of the disease[].group names in aiFindings above; if none is a genuine fit, pick the closest one " +
  "without inventing a rationale for the fit in the result text. Every diseaseResults group MUST be " +
  "one of the disease groups. Emit the result ONLY through the emit_disease_results tool.";
