import { readSheetRows, firstSheetName } from "./xlsx-safe";
import type { MarkerResult } from "../types";

const SOURCE = "Scale";
const GROUP_ANTHRO = "Anthropometrics";
const GROUP_BC = "Body Composition – Total";

function toDate(raw: unknown): string | undefined {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (raw == null) return undefined;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function toNum(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return isFinite(n) ? n : undefined;
}

export async function parseWeightApp(bytes: Uint8Array): Promise<MarkerResult[]> {
  const rows = readSheetRows(bytes);

  const out: MarkerResult[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const date = toDate(r[0]);
    if (!date) continue;
    const sm = toNum(r[1]);
    const fat = toNum(r[2]);
    const wt = toNum(r[3]);
    if (sm === undefined && fat === undefined && wt === undefined) continue;
    if (wt !== undefined) {
      out.push({ marker: "Weight (Scale)", group: GROUP_ANTHRO, source: SOURCE, date, value: wt, unit: "kg" });
    }
    if (sm !== undefined) {
      out.push({ marker: "Skeletal muscle mass (Scale)", group: GROUP_BC, source: SOURCE, date, value: sm, unit: "kg" });
    }
    if (fat !== undefined) {
      out.push({ marker: "Body fat mass (Scale)", group: GROUP_BC, source: SOURCE, date, value: fat, unit: "kg" });
    }
  }
  return out;
}

export function isWeightAppSheet(bytes: Uint8Array): boolean {
  if (firstSheetName(bytes) === "inbody") return true;
  const rows = readSheetRows(bytes);
  const header = (rows[0] ?? []).map((c) => String(c ?? "").toLowerCase());
  return header[0] === "date" && header.some((c) => c.includes("muscle")) && header.some((c) => c.includes("fat"));
}
