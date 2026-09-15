import { createHash } from "node:crypto";

// W13g: the pure provenance helpers (storedName/subtypeFor/findSourceBySha/upsertSourceRecord/…)
// moved to src/lib/ingest-core.ts so a browser/Function shares them; re-exported here so the CLI's
// import path is unchanged. Only hashSource stays Node-bound (node:crypto; a browser uses SubtleCrypto).
export {
  formatDate,
  dateSegment,
  typeForKind,
  slugStudyType,
  subtypeFor,
  storedName,
  findSourceBySha,
  upsertSourceRecord,
} from "@pablotech/akesi/ingest-core";

export function hashSource(bytes: Uint8Array): { sha256: string; id: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, id: sha256.slice(0, 12) };
}
