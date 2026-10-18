import { loadJSON, saveJSON } from "@tinytars/frame/persisted-json";
import { AI_SECTIONS, PATIENT_SECTIONS } from "./report-sections";

const KEY = "hd_sidebar_mode";

export type SidebarMode = "patient" | "investigator";

export function loadSidebarMode(): SidebarMode {
  return loadJSON<SidebarMode>(KEY, "patient") === "investigator" ? "investigator" : "patient";
}

export function saveSidebarMode(mode: SidebarMode): void {
  saveJSON(KEY, mode);
}

// Which sidebar mode a section belongs to, or null for a key that's neither (e.g. "chat", which has
// no SectionMeta of its own) — callers that mean "leave the current mode alone" rely on that null.
export function modeForSection(section: string | null): SidebarMode | null {
  if (AI_SECTIONS.some((s) => s.key === section)) return "investigator";
  if (PATIENT_SECTIONS.some((s) => s.key === section)) return "patient";
  return null;
}
