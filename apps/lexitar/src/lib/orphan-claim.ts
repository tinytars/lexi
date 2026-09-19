// W76 — reclaim a client's ORPHANED namespace (objects stored before ownership recording, for a patient
// the org-key backfill can't attribute). The server refuses orphans on every route, so the owner proves
// possession instead: the full SHA-256 their vault records for each stored original, which only someone
// holding the file can produce. One call per client when the owner opens their vault; for a namespace
// that is already theirs the server answers 204 and does nothing.
import type { Client, Vault } from "./types";
import { normalizeClientId } from "./client-id";

const MAX_PROOFS = 5;

export interface ClaimProof {
  file: string;
  sha256: string;
}

/** The stored originals this client can prove, newest record last — at most what the route accepts. */
export function claimProofs(client: Client): ClaimProof[] {
  const records = [...(client.sources ?? []), ...(client.pendingUploads ?? [])];
  return records.slice(-MAX_PROOFS).map((r) => ({ file: r.file.split("/").pop()!, sha256: r.sha256 }));
}

/** Best-effort: a failed claim leaves the namespace exactly as refused as it already was. */
export async function reclaimOrphans(vault: Vault): Promise<void> {
  await Promise.all(
    Object.entries(vault.clients).map(async ([clientId, client]) => {
      const proofs = claimProofs(client);
      if (!proofs.length) return;
      await fetch("/api/raw/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: normalizeClientId(clientId), proofs }),
      }).catch(() => undefined);
    }),
  );
}
