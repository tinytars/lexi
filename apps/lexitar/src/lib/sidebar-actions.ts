export type SidebarVerb = "new" | "add";

export interface SidebarAction {
  key: string;
  verb: SidebarVerb;
  label: string;
}

// Keys must stay in lockstep with src/lib/report-sections.ts's SectionMeta keys (same
// convention as visibility.ts's FEATURES catalog), or the literal "chat".
export const SIDEBAR_ACTIONS: SidebarAction[] = [
  { key: "chat", verb: "new", label: "New chat" },
  { key: "markers", verb: "add", label: "Import spreadsheet" },
  { key: "healthReports", verb: "add", label: "Import report" },
  { key: "treatment", verb: "add", label: "Add treatment" },
  { key: "allergies", verb: "add", label: "Add allergy" },
  { key: "familyHistory", verb: "add", label: "Add family history" },
  { key: "notes", verb: "add", label: "Add note" },
  { key: "study", verb: "add", label: "Add study" },
  { key: "futureTreatment", verb: "add", label: "Add idea" },
];

export function sidebarActionFor(key: string): SidebarAction | undefined {
  return SIDEBAR_ACTIONS.find((a) => a.key === key);
}
