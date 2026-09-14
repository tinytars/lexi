import { loadJSON, saveJSON } from "@tinytars/frame/persisted-json";
import type { SidebarMode } from "./sidebar-mode";

// Two independent memories, both scoped per client:
// - last SECTION visited in each sidebar mode (drives the mode-toggle jumping back to it)
// - last GROUP visited within each section (independent of mode — a section belongs to exactly one
//   mode already, and this preserves a per-section memory across visits to other sections, the way
//   the pre-M105 in-memory lastGroupBySection did).
// Kept as two maps rather than one combined {section, group} slot per mode: a single combined slot
// gets overwritten wholesale by the next section visited in the same mode, silently losing the
// previous section's remembered group.
const SECTION_KEY = "hd_last_section_v1";
const GROUP_KEY = "hd_last_group_v1";

type SectionMemory = Record<string, Partial<Record<SidebarMode, string>>>;
type GroupMemory = Record<string, Record<string, string>>;

export function loadLastSection(clientId: string | null, mode: SidebarMode | null): string | null {
  if (!clientId || !mode) return null;
  return loadJSON<SectionMemory>(SECTION_KEY, {})[clientId]?.[mode] ?? null;
}

export function saveLastSection(clientId: string | null, mode: SidebarMode | null, section: string): void {
  if (!clientId || !mode) return;
  const memory = loadJSON<SectionMemory>(SECTION_KEY, {});
  memory[clientId] = { ...memory[clientId], [mode]: section };
  saveJSON(SECTION_KEY, memory);
}

export function loadLastGroup(clientId: string | null, section: string | null): string | null {
  if (!clientId || !section) return null;
  return loadJSON<GroupMemory>(GROUP_KEY, {})[clientId]?.[section] ?? null;
}

export function saveLastGroup(clientId: string | null, section: string | null, group: string): void {
  if (!clientId || !section) return;
  const memory = loadJSON<GroupMemory>(GROUP_KEY, {});
  memory[clientId] = { ...memory[clientId], [section]: group };
  saveJSON(GROUP_KEY, memory);
}
