// W46 Phase 4 — one shared "open the native file picker" registry, mirroring
// menu-registry.svelte.ts's singleton shape: a single hidden <input type=file> (AttachPicker.svelte,
// mounted once in App.svelte) is driven by whichever leaf's "Attach" action last called
// openAttachPicker, instead of every leaf owning its own hidden input.
export type AttachMode = "camera" | "library" | "files";

// Everything. A leaf's Attach is storage, not import: whatever you attach is kept, shown, and — if
// it is a PDF or a text file — read so LexiTar can quote it. Anything else simply attaches and sits
// there, which is strictly better than a file picker that greys the file out with no explanation.
//
// The narrow "image/*,application/pdf,.xlsx,.xls" this replaces meant a .docx, a .csv or a .heic
// could not even be SELECTED from any leaf. **Reports is the one surface that refuses a file** — and
// it refuses on what the document turns out to be (report-extract.ts's isMedicalReport gate), not on
// its extension, which is a judgement a file picker cannot make.
export const DEFAULT_ATTACH_ACCEPT = "*/*";

type Opener = (mode: AttachMode, onFiles: (files: File[]) => void, accept?: string) => void;

let opener: Opener | null = null;

export function registerAttachPicker(fn: Opener): void {
  opener = fn;
}

export function openAttachPicker(mode: AttachMode, onFiles: (files: File[]) => void, accept?: string): void {
  opener?.(mode, onFiles, accept);
}
