import { describe, it, expect, vi } from "vitest";

// Mock the SDK so the Function's session gate + shape validation are exercised with no billable call.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    // runLeafRegen streams (LEAF_REGEN_MAX_TOKENS is only requestable that way), but it still reads
    // one final message — so the mock stays a plain resolved response and createMock keeps receiving
    // the same params object the assertions below inspect.
    messages = { stream: (...args: unknown[]) => ({ finalMessage: () => createMock(...args) }) };
  },
}));

import { onRequestPost } from "../../functions/api/leaf-regen";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "./_session-db";

const ENV = { ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret", DB: fakeSessionDb() };

function toolResponse(input: unknown, name = "emit_study_results") {
  return {
    content: [{ type: "tool_use", name, input }],
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

async function call(body: unknown, opts: { auth?: boolean } = { auth: true }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  return onRequestPost({
    request: new Request("http://x/api/leaf-regen", { method: "POST", headers, body: JSON.stringify(body) }),
    env: ENV,
  });
}

const bodyJson = async (res: Response) => JSON.parse(await res.text());

// W75 — the relay validated `documents` for SHAPE and passed the text straight through, so the
// per-document and total caps that document-extract-client.ts applies bounded this app's browser and
// nothing else: a CLI or scripted caller was bounded only by the 8 MB body cap.
describe("functions/api/leaf-regen: document caps are enforced at the relay, not just in the browser", () => {
  it("truncates an over-long document before it reaches the model, and says so in the text", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "g" }] }));
    const res = await call({
      node: "studyResults",
      inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } },
      documents: [{ name: "huge.pdf", text: "z".repeat(200_000) }],
    });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(createMock.mock.calls.at(-1)![0].messages);
    expect(sent).toContain("[document truncated here");
    expect(sent.length).toBeLessThan(120_000);
  });
});

describe("functions/api/leaf-regen: targetLabels", () => {
  it("400s when targetLabels is present but not an array of strings", async () => {
    const res = await call({ node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } }, targetLabels: "not-an-array" });
    expect(res.status).toBe(400);
    expect((await bodyJson(res)).error).toMatch(/targetLabels must be an array of strings/);
  });

  it("400s when targetLabels contains a non-string element", async () => {
    const res = await call({ node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } }, targetLabels: ["ok", 5] });
    expect(res.status).toBe(400);
    expect((await bodyJson(res)).error).toMatch(/targetLabels must be an array of strings/);
  });

  it("appends a SCOPE OVERRIDE clause naming the given labels to the system prompt", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "Best time of day to take vitamin D", result: "x", group: "Cardiovascular Risk" }] }));
    const res = await call({
      node: "studyResults",
      inputs: { pursuedStudy: { entries: [{ focus: "Best time of day to take vitamin D", detail: "" }] } },
      targetLabels: ["Best time of day to take vitamin D"],
    });
    expect(res.status).toBe(200);
    const system = createMock.mock.calls.at(-1)![0].system as string;
    expect(system).toContain("SCOPE OVERRIDE");
    expect(system).toContain('"Best time of day to take vitamin D"');
  });

  // Regression for a live bug: a scope note placed only AFTER the node's systemPromptExtra (which
  // spends many sentences instructing "answer every populated row") contradicts rather than overrides
  // it, and the tool schema's own row-array description said the same "every row" thing — on Alex's
  // 19-row Study list the model apparently followed that dominant framing, tried to answer every row,
  // and overran max_tokens, coming back with no `items` key at all (spec.validate's "items missing or
  // not an array"). The fix: the SCOPE OVERRIDE must appear BEFORE systemPromptExtra, and the tool
  // schema sent to the model must be patched to agree with the scope instead of contradicting it.
  it("places the SCOPE OVERRIDE before the node's systemPromptExtra, and patches the tool schema to match", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "Suspicion", result: "x", group: "Cardiovascular Risk" }] }));
    const res = await call({
      node: "studyResults",
      inputs: { pursuedStudy: { entries: [{ id: "e1", focus: "Suspicion", detail: "x" }] } },
      targetLabels: ["Suspicion"],
    });
    expect(res.status).toBe(200);
    const callArgs = createMock.mock.calls.at(-1)![0];
    const system = callArgs.system as string;
    expect(system.indexOf("SCOPE OVERRIDE")).toBeLessThan(system.indexOf("You answer each populated row"));

    const tool = callArgs.tools[0];
    expect(tool.description).toContain("SCOPED for this call");
    expect(tool.input_schema.properties.items.description).toContain("SCOPED for this call");
  });

  it("omits the SCOPE OVERRIDE clause when targetLabels is absent", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "Cardiovascular Risk" }] }));
    const res = await call({ node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } } });
    expect(res.status).toBe(200);
    const system = createMock.mock.calls.at(-1)![0].system as string;
    expect(system).not.toContain("SCOPE OVERRIDE");
  });

  it("omits the SCOPE OVERRIDE clause when targetLabels is an empty array", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ study: "x", result: "y", group: "Cardiovascular Risk" }] }));
    const res = await call({ node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } }, targetLabels: [] });
    expect(res.status).toBe(200);
    const system = createMock.mock.calls.at(-1)![0].system as string;
    expect(system).not.toContain("SCOPE OVERRIDE");
  });
});

// W46 Phase 7 — treatmentAssessment/diseaseResults attachments ride as real Anthropic `image`
// content blocks (finding-vision.ts's closed whitelist decides which nodes ever populate this;
// the relay itself just trusts the shape, same as it already trusts `inputs`).
// W71 — the treatment carries its id, because treatmentAssessment now has to echo it back and the
// relay's validator checks the returned ids against exactly this list.
const TREATMENT_INPUTS = { patientAssessment: "x", markerLevels: [], treatmentHistory: [{ id: "t1", name: "Statin", start: "2024-01" }], aiFindings: [] };

describe("functions/api/leaf-regen: images (W46 Phase 7 vision)", () => {
  it("400s when images is present but not an array of {mediaType, base64}", async () => {
    const res = await call({ node: "treatmentAssessment", inputs: TREATMENT_INPUTS, images: "nope" });
    expect(res.status).toBe(400);
    expect((await bodyJson(res)).error).toMatch(/images must be an array/);
  });

  it("400s when an image entry is missing a required field", async () => {
    const res = await call({ node: "treatmentAssessment", inputs: TREATMENT_INPUTS, images: [{ mediaType: "image/jpeg" }] });
    expect(res.status).toBe(400);
    expect((await bodyJson(res)).error).toMatch(/images must be an array/);
  });

  it("sends a bare JSON string as content when images is absent (unchanged shape)", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ treatmentId: "t1", item: "Statin", assessment: "x", group: "Cardiovascular Risk" }] }, "emit_treatment_assessment"));
    const res = await call({ node: "treatmentAssessment", inputs: TREATMENT_INPUTS });
    expect(res.status).toBe(200);
    const content = createMock.mock.calls.at(-1)![0].messages[0].content;
    expect(typeof content).toBe("string");
  });

  it("sends image blocks before a trailing text block when images is present", async () => {
    createMock.mockResolvedValueOnce(toolResponse({ items: [{ treatmentId: "t1", item: "Statin", assessment: "x", group: "Cardiovascular Risk" }] }, "emit_treatment_assessment"));
    const res = await call({
      node: "treatmentAssessment",
      inputs: TREATMENT_INPUTS,
      images: [{ mediaType: "image/jpeg", base64: "Zm9v" }],
    });
    expect(res.status).toBe(200);
    const content = createMock.mock.calls.at(-1)![0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Zm9v" } });
    expect(content.at(-1).type).toBe("text");
    expect(JSON.parse(content.at(-1).text)).toEqual(TREATMENT_INPUTS);
  });
});

describe("functions/api/leaf-regen: targetLabels (per-node wording)", () => {
  // M68 P5 — the SCOPE OVERRIDE mechanism (Context item 1/Phase 1 of the M68 plan doc) is generic
  // across every row-scoped node, keyed only on `body.node`, not hardcoded to studyResults — prove it
  // for the two nodes M68 newly wired up, including treatmentAssessment's node-specific wording
  // (dose-annotation-insensitive matching) vs. the other nodes' shared verbatim-match wording.
  it("appends a SCOPE OVERRIDE clause for treatmentAssessment, using its dose-insensitive wording", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse({ items: [{ treatmentId: "rosu-1", item: "Rosuvastatin 20 mg", assessment: "x", group: "Cardiovascular Risk" }] }, "emit_treatment_assessment"),
    );
    const res = await call({
      node: "treatmentAssessment",
      inputs: { treatmentHistory: [{ id: "rosu-1", name: "Rosuvastatin", kind: "medication", start: "2024-01" }] },
      targetLabels: ["Rosuvastatin"],
    });
    expect(res.status).toBe(200);
    const system = createMock.mock.calls.at(-1)![0].system as string;
    expect(system).toContain("SCOPE OVERRIDE");
    expect(system).toContain('"Rosuvastatin"');
    expect(system).toContain("ignoring dose-annotation differences");
  });

  it("appends a SCOPE OVERRIDE clause for hypothesisEvaluation, using the shared verbatim-match wording", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(
        { patient: [{ intervention: "Methylation stack", purpose: "overnight HRV", pros: ["p1", "p2"], cons: ["c1", "c2"], alternatives: ["a1", "a2"], recommendation: "Discuss it.", questions: ["ask about it"] }] },
        "emit_hypothesis_evaluation",
      ),
    );
    const res = await call({
      node: "hypothesisEvaluation",
      inputs: { patientHypothesis: [{ intervention: "Methylation stack", purpose: "overnight HRV" }] },
      targetLabels: ["Methylation stack"],
    });
    expect(res.status).toBe(200);
    const system = createMock.mock.calls.at(-1)![0].system as string;
    expect(system).toContain("SCOPE OVERRIDE");
    expect(system).toContain('"Methylation stack"');
    expect(system).toContain("copied verbatim");
  });
});

// Owner's vocabulary (2026-08-21): this route is TRANSLATE — one turn's reply — and a user turn
// always gets one. It is session-gated and nothing more. PROVIDER_TOKEN guards "Translate all"
// (/api/refresh-finding) instead. A brief W62 experiment required the bearer here too, which meant a
// patient could add a note and never get an answer; these two pin the shape that replaced it.
describe("functions/api/leaf-regen: a user turn always gets its reply", () => {
  const goodBody = { node: "studyResults", inputs: { pursuedStudy: { entries: [{ focus: "x", detail: "y" }] } } };

  it("does not require a provider token — a signed-in session is enough", async () => {
    const res = await call(goodBody);
    expect(res.status).not.toBe(401);
  });

  it("still requires a session — this is not an open relay", async () => {
    const res = await call(goodBody, { auth: false });
    expect(res.status).toBe(401);
  });
});
