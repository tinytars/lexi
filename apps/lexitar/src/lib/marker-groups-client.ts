// M95 — browser side of the web-triggered marker->body-system classification, mirroring
// refresh-client.ts's refreshFinding() contract: returns the result, caller persists (sets
// client.markerGroups + saves the vault). Available to the account owner (same-origin session
// cookie, no providerToken) and any granted provider (providerToken set).
import type { Client, MarkerGrouping } from "./types";
import { distinctMarkerNames, markerGroupsHashOf } from "@pablotech/akesi-pil/marker-groups-prompt";
import { systemOrder } from "@pablotech/akesi-pil/system-groups";

const SENTINEL = "[[REFRESH_ERROR]]";

export interface RefreshError extends Error {
  errorCode?: string;
}

export async function refreshMarkerGroups(
  client: Client,
  opts: { providerToken?: string; force?: boolean } = {},
): Promise<MarkerGrouping> {
  const systems = systemOrder(client);
  const hash = markerGroupsHashOf(distinctMarkerNames(client), systems);
  if (!opts.force && client.markerGroups?.markerGroupsHash === hash) {
    return client.markerGroups;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.providerToken) headers.Authorization = `Bearer ${opts.providerToken}`;

  const res = await fetch("/api/refresh-marker-groups", {
    method: "POST",
    headers,
    body: JSON.stringify({ client }),
  });
  if (!res.ok || !res.body) {
    let payload: { error?: string; errorCode?: string } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON */
    }
    const err = new Error(payload.error || `refresh failed (${res.status})`) as RefreshError;
    err.errorCode = payload.errorCode;
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }

  const at = text.indexOf(SENTINEL);
  if (at >= 0) {
    const err = new Error(text.slice(at + SENTINEL.length).trim() || "generation failed") as RefreshError;
    err.errorCode = "generation_failed";
    throw err;
  }

  // The stream carries `[[PASS]] N` progress lines followed by the complete MarkerGrouping
  // JSON on its own final line.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return JSON.parse(last) as MarkerGrouping;
}
