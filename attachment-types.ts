// Domain-neutral shape for one stored file (mirrors Attachment in health-dash-web's
// @pablotech/akesi-pil/types, kept structurally compatible so callers can pass their own
// Attachment values straight through without either side importing the other's type — the
// same pattern Diagnostics.svelte's DiagnosticsLogEntry uses).
export interface Attachment {
  key: string;
  name: string;
  mediaType: string;
  bytes: number;
  addedAt: string;
  extracted?: {
    at: string;
    chars: number;
    kind?: string;
    error?: string;
  };
}
