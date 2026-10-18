import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { fetchAttachmentBase64 } = vi.hoisted(() => ({ fetchAttachmentBase64: vi.fn() }));
vi.mock("../../src/lib/attachment-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchAttachmentBase64,
}));

import { fetchLeafRegen, applyLeafRegen, type PendingLeafRegen } from "../../src/lib/leaf-regen-client";
import { AiError } from "../../src/lib/ai-error";
import { warmCorpus } from "../../src/lib/corpus-warm-client";
import type { Client } from "../../src/lib/types";

// Minimal client carrying exactly one allergy — allergyResults has the simplest non-empty context
// of any leaf, so this exercises the transport without dragging in a whole Finding fixture.
function clientWithAllergies(): Client {
  return {
    displayName: "Alex",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    factors: { allergies: [{ id: "allergy-1", allergen: "Penicillin", reaction: "Hives" }] },
  } as unknown as Client;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.restoreAllMocks());

describe("fetchLeafRegen error reporting", () => {
  // The relay already classifies every failure; before this the client read res.text() and
  // concatenated the raw JSON into a message, destroying errorCode twice over.
  it.each([
    [402, "insufficient_credit"],
    [503, "ai_busy"],
    [502, "model_error"],
    [422, "invalid_leaf_regen"],
  ])("preserves errorCode and status from a %i", async (status, errorCode) => {
    vi.mocked(fetch).mockResolvedValue(json(status, { error: "relay prose", errorCode }));
    const err = await fetchLeafRegen(clientWithAllergies(), "allergyResults").catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ errorCode, status });
  });

  it("still throws something typed when the body is not JSON at all", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const err = await fetchLeafRegen(clientWithAllergies(), "allergyResults").catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).status).toBe(502);
  });

  it("reports a transport failure as offline rather than a bare TypeError", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await fetchLeafRegen(clientWithAllergies(), "allergyResults").catch((e) => e);
    expect(err).toMatchObject({ errorCode: "offline" });
  });

  it("sends an abort signal, so the deadline can actually cancel the request", async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { result: { allergyResults: [] } }));
    await fetchLeafRegen(clientWithAllergies(), "allergyResults").catch(() => {});
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates a caller abort as an abort, not as a failure", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await fetchLeafRegen(clientWithAllergies(), "allergyResults", undefined, undefined, ctrl.signal)
      .catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips the call entirely when the node has nothing to regenerate", async () => {
    const empty = { ...clientWithAllergies(), factors: { allergies: [] } } as unknown as Client;
    await expect(fetchLeafRegen(empty, "allergyResults")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("leaf context construction", () => {
  // treatmentGroups' buildContext returns RegroupInputs, not DAG-input keys. Building it generically
  // produced a context its own isEmpty could not read, and the resulting TypeError named neither the
  // node nor the cause.
  it("uses a node's own buildContext, so treatmentGroups gets RegroupInputs", async () => {
    const c = clientWithAllergies();
    const withPlan = {
      ...c,
      finding: { disease: [{ group: "Metabolic" }], decisions: { ai: [{ intervention: "X", purpose: "y" }] } },
      factors: { ...c.factors, decisions: [{ intervention: "Methylation stack", purpose: "hrv" }] },
    } as unknown as Client;
    vi.mocked(fetch).mockResolvedValue(json(200, { result: { groups: [] } }));
    await fetchLeafRegen(withPlan, "treatmentGroups").catch(() => {});
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(Object.keys(sent.inputs).sort()).toEqual(["aiInterventions", "patientHypotheses", "planActions", "systems"]);
  });
});


// treatmentAssessment is one of the two vision-enabled nodes: its treatments' photos are fetched
// back from raw storage and folded into the request as image blocks.
function clientWithPhotoTreatment(): Client {
  return {
    displayName: "Alex",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [],
    finding: { disease: [{ group: "Metabolic" }] },
    factors: {
      treatments: [{
        id: "t1", name: "Rosuvastatin", kind: "drug", start: "2020-01-01",
        attachments: [
          { key: "gone.jpg", mediaType: "image/jpeg", name: "gone.jpg" },
          { key: "here.jpg", mediaType: "image/jpeg", name: "here.jpg" },
        ],
      }],
    },
  } as unknown as Client;
}

describe("vision attachments", () => {
  // The live bug: one unfetchable photo rejected the whole Promise.all BEFORE the relay was ever
  // called, so the leaf's Translate died with a photo error — and the background sweep that would
  // have retried it hit the single-flight lock and was dropped, leaving the leaf un-regenerated.
  it("still calls the relay when an attachment cannot be fetched, minus that image", async () => {
    fetchAttachmentBase64.mockImplementation(async (_id: string, key: string) => {
      if (key === "gone.jpg") throw new Error("404");
      return "AAAA";
    });
    vi.mocked(fetch).mockResolvedValue(json(200, { result: { items: [] } }));
    await fetchLeafRegen(clientWithPhotoTreatment(), "treatmentAssessment", undefined, "alex");
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.images).toEqual([{ mediaType: "image/jpeg", base64: "AAAA" }]);
  });

  it("sends no images at all when every attachment fails, rather than failing the regen", async () => {
    fetchAttachmentBase64.mockRejectedValue(new Error("404"));
    vi.mocked(fetch).mockResolvedValue(json(200, { result: { items: [] } }));
    await fetchLeafRegen(clientWithPhotoTreatment(), "treatmentAssessment", undefined, "alex");
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.images).toBeUndefined();
  });
});

describe("applyLeafRegen stamping", () => {
  // The whole point of carrying inputHash on PendingLeafRegen: a concurrent edit can land during the
  // round-trip fetchLeafRegen took, so `client` here (whatever is live at save time) no longer reads
  // the same as what `validated` actually answers. Stamping from a hash recomputed against THIS client
  // would mark the node fresh against input it never saw — this proves the stamp instead comes from
  // pending.inputHash, the hash taken at request time.
  it("stamps nodeHashes from the request-time inputHash, not the merge-time client", async () => {
    const client = {
      displayName: "Alex",
      dob: "1980-01-01",
      gender: "male",
      watchlist: [],
      results: [],
      // A concurrent edit landed after the request was built: a second allergy is now on the live
      // client, so its OWN current nodeHashNow would differ from the request-time hash below.
      factors: { allergies: [{ id: "allergy-1", allergen: "Penicillin", reaction: "Hives" }, { id: "allergy-2", allergen: "Latex", reaction: "Rash" }] },
      finding: { nodeHashes: { allergyResults: "stale-before-hash" }, allergyResults: [] },
    } as unknown as Client;
    const pending: PendingLeafRegen = {
      node: "allergyResults",
      validated: { items: [] },
      inputHash: "request-time-hash",
    };
    const result = await applyLeafRegen(client, pending, "translate");
    expect(result.finding!.nodeHashes!.allergyResults).toBe("request-time-hash");
  });
});

describe("attached documents and the report corpus", () => {
  // Where the corpus is on, the relay attaches the PDF itself and the transcription would be the
  // same document a second time. Where it is off, the transcription is the only copy there is —
  // which is why this is a question the client asks rather than a line that was deleted.
  function clientWithAttachments(): Client {
    const attachments = [
      { key: "raw/alex/abc-report.pdf", name: "report.pdf", mediaType: "application/pdf" },
      { key: "raw/alex/def-notes.txt", name: "notes.txt", mediaType: "text/plain" },
    ];
    return {
      displayName: "Alex",
      dob: "1980-01-01",
      gender: "male",
      watchlist: [],
      results: [],
      factors: { allergies: [{ id: "allergy-1", allergen: "Penicillin", reaction: "Hives", attachments }] },
    } as unknown as Client;
  }

  /** Answers the sidecar reads with the file's own name, and the regen POST with the one row asked for. */
  function route(): void {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/document-extract")) {
        const key = new URL(url, "http://x").searchParams.get("key") ?? "";
        return json(200, { text: `transcribed ${key}` });
      }
      return json(200, { result: { items: [{ allergyId: "allergy-1", result: "Avoid penicillin.", group: "Allergy" }] } });
    });
  }

  const documentsSent = () => {
    const post = vi.mocked(fetch).mock.calls.find(([u]) => String(u).startsWith("/api/leaf-regen"))!;
    return (JSON.parse((post[1] as RequestInit).body as string) as { documents?: { name: string }[] }).documents;
  };

  async function withReports(reason: string): Promise<void> {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { warmed: false, reason }));
    await warmCorpus("alex", "metric");
  }

  it("leaves a PDF's transcription out when the model already has the PDF", async () => {
    await withReports("no_corpus");
    route();

    await fetchLeafRegen(clientWithAttachments(), "allergyResults", undefined, "alex");

    expect(documentsSent()?.map((d) => d.name)).toEqual(["notes.txt"]);
  });

  it("still sends it where reports are off, because then it is the only copy", async () => {
    await withReports("off");
    route();

    await fetchLeafRegen(clientWithAttachments(), "allergyResults", undefined, "alex");

    expect(documentsSent()?.map((d) => d.name)).toEqual(["report.pdf", "notes.txt"]);
  });
});
