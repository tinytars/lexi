// Domain-neutral shape for one stored file, kept structurally compatible with a caller's own
// attachment type so it can pass its own values straight through without either side importing
// the other's type — the same pattern Diagnostics.svelte's DiagnosticsLogEntry uses.
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
