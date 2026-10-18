import type { Client } from "./types";
import type { Tab } from "./nav";
import type { SidebarGroupRow, SidebarLeafRow } from "@tinytars/frame/sidebar-rows";
import { sidebarActionFor, type SidebarVerb } from "./sidebar-actions";
import { markerSidebarGroups, markerGroupsPending } from "./marker-sidebar-groups";
import { treatmentSidebarBuckets } from "./treatment-sidebar";
import { hypothesisSidebarGroups, hypothesisGroupsPending } from "./hypothesis-sidebar-groups";
import { explorationSidebarGroups, explorationGroupsPending } from "./exploration-sidebar-groups";
import { questionsSidebarGroups } from "./questions-sidebar-groups";
import { glossarySidebarGroups } from "./glossary-sidebar-groups";
import { reportSidebarGroups } from "./report-sidebar-groups";
import { allergySidebarRows, familySidebarRows, notesSidebarGroups, studySidebarGroups } from "./sidebar-leaf-rows";
import { PRODUCT_NAME } from "./brand";

export type LowerZoneKind =
  | "chat" | "markers" | "treatment" | "hypothesis" | "personalization" | "notes" | "study"
  | "healthReports" | "questions" | "glossary" | "analysis" | "exploration";

// W48 — Allergies/Family share Profile's zone so its Bio/Allergies/Family list stays visible on all three.
const SECTION_ZONE = new Map<string, LowerZoneKind>([
  ["markers", "markers"],
  ["healthReports", "healthReports"],
  ["treatment", "treatment"],
  ["personalization", "personalization"],
  ["allergies", "personalization"],
  ["familyHistory", "personalization"],
  ["notes", "notes"],
  ["docInference", "questions"],
  ["definitions", "glossary"],
  ["futureTreatment", "hypothesis"],
  ["study", "study"],
  ["analysis", "analysis"],
  ["exploration", "exploration"],
]);

// Chat's `active` is a thread id, not a section key, so the tab decides there.
export function lowerZoneKindFor(activeTab: Tab, active: string | null): LowerZoneKind | null {
  if (activeTab === "chat") return "chat";
  return (active && SECTION_ZONE.get(active)) || null;
}

export interface LowerZoneModel {
  groupRows: SidebarGroupRow[];
  pendingNote: string | null;
  leafRows: SidebarLeafRow[];
}

const EMPTY: LowerZoneModel = { groupRows: [], pendingNote: null, leafRows: [] };

export function lowerZoneModel(
  kind: LowerZoneKind | null,
  client: Client | null,
  active: string | null,
  today: string,
  onAction: (key: string, verb: SidebarVerb) => void,
): LowerZoneModel {
  if (!kind || !client) return EMPTY;
  return {
    groupRows: groupRowsFor(kind, client, today, onAction),
    pendingNote: groupsPending(kind, client) ? `Grouped by body system once the ${PRODUCT_NAME} Translation runs.` : null,
    leafRows: leafRowsFor(kind, client, active),
  };
}

function groupRowsFor(kind: LowerZoneKind, client: Client, today: string, onAction: (key: string, verb: SidebarVerb) => void): SidebarGroupRow[] {
  switch (kind) {
    case "markers": return markerSidebarGroups(client);
    case "treatment": return treatmentSidebarBuckets(client, today);
    case "hypothesis": return hypothesisSidebarGroups(client);
    case "exploration": return explorationSidebarGroups(client);
    case "healthReports": return reportSidebarGroups(client);
    case "personalization": return personalizationGroups(client, onAction);
    case "notes": return notesSidebarGroups(client);
    case "study": return studySidebarGroups(client);
    case "questions": return questionsSidebarGroups(client);
    case "glossary": return glossarySidebarGroups(client);
    default: return [];
  }
}

function personalizationGroups(client: Client, onAction: (key: string, verb: SidebarVerb) => void): SidebarGroupRow[] {
  const addRow = (key: "allergies" | "familyHistory") => {
    const action = sidebarActionFor(key)!;
    return { label: action.label, onClick: () => onAction(key, action.verb) };
  };
  return [
    { key: "personalization", label: "Bio" },
    { key: "allergies", label: "Allergies", count: allergySidebarRows(client).length, action: addRow("allergies") },
    { key: "familyHistory", label: "Family", count: familySidebarRows(client).length, action: addRow("familyHistory") },
  ];
}

function groupsPending(kind: LowerZoneKind, client: Client): boolean {
  if (kind === "markers") return markerGroupsPending(client);
  if (kind === "hypothesis") return hypothesisGroupsPending(client);
  if (kind === "exploration") return explorationGroupsPending(client);
  return false;
}

// Bio is a single form, so only Allergies/Family list their own items under Profile.
function leafRowsFor(kind: LowerZoneKind, client: Client, active: string | null): SidebarLeafRow[] {
  if (kind !== "personalization") return [];
  if (active === "allergies") return allergySidebarRows(client);
  if (active === "familyHistory") return familySidebarRows(client);
  return [];
}
