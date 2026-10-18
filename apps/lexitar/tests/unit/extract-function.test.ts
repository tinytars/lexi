import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Anthropic SDK so the Function's own behaviour (guard, validation, the
// PDF-document-block relay contract, error mapping) is exercised with no billable call.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { onRequestPost } from "../../functions/api/extract";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";
import { resetServerErrorDedupe } from "../../functions/_lib/server-error";

const ENV = { SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), ANTHROPIC_API_KEY: "k" };

const VALID_REPORT = {
  studyType: "Coronary CTA",
  diseases: [{ date: "2019-04-02", diagnostic: "CAC: 210; CAD-RADS 3 in the Proximal RCA", summary: "Total CAC 210; proximal RCA calcified plaque, CAD-RADS 3.", confidence: 0.95 }],
  comorbidities: [],
  priorComparisons: [],
  markers: [{ marker: "Coronary artery calcium (CAC) score", value: 210, unit: "", date: "2019-04-02", group: "Cardiac Imaging", confidence: 0.98 }],
};

const PATIENT = { dob: "1980-01-01", gender: "male", factors: { diseases: [] } };

const background: Promise<unknown>[] = [];

async function call(opts: { auth?: "valid" | "bogus"; body?: string; env?: typeof ENV } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth === "valid") headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  else if (opts.auth === "bogus") headers.cookie = "hd_session=bogus";
  return onRequestPost({
    request: new Request("http://local/api/extract", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ sourceFile: "coronary.pdf", pdfBase64: "JVBERi0x", patient: PATIENT }),
    }),
    env: opts.env ?? ENV,
    waitUntil: (p) => void background.push(p),
  });
}

// Draining first: a report filed with waitUntil outlives the test that triggered it, and its
// fingerprint would otherwise land in the dedupe set after the next test cleared it.
beforeEach(async () => {
  await Promise.all(background);
  background.length = 0;
  resetServerErrorDedupe();
  create.mockReset();
  create.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(VALID_REPORT) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
});

describe("/api/extract guard + validation", () => {
  it("401s with no / bogus session and never calls the model", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ auth: "bogus" })).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON", async () => {
    expect((await call({ auth: "valid", body: "{not json" })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s when pdfBase64 is missing", async () => {
    const res = await call({ auth: "valid", body: JSON.stringify({ sourceFile: "x.pdf", patient: PATIENT }) });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("no_pdf");
    expect(create).not.toHaveBeenCalled();
  });

  it("400s on pageImages that are not images, rather than relaying them", async () => {
    const body = JSON.stringify({ sourceFile: "x.pdf", patient: PATIENT, pageImages: [{ base64: "AAA", mediaType: "application/pdf" }] });
    const res = await call({ auth: "valid", body });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("no_pdf");
    expect(create).not.toHaveBeenCalled();
  });

  it("400s when patient (dob/gender) is missing/invalid", async () => {
    const res = await call({ auth: "valid", body: JSON.stringify({ pdfBase64: "JVBERi0x", patient: { dob: "1980-01-01" } }) });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("no_patient");
  });

  it("413s on an oversized body", async () => {
    const big = "A".repeat(24 * 1024 * 1024 + 1);
    const res = await call({ auth: "valid", body: big });
    expect(res.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("/api/extract happy path", () => {
  it("200s with the validated ProposedReport and sends the PDF as a base64 document block", async () => {
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_REPORT);

    // The model saw a document content block carrying the base64 PDF + a json_schema output.
    const args = create.mock.calls[0][0];
    const userContent = args.messages[0].content;
    expect(Array.isArray(userContent)).toBe(true);
    const doc = userContent.find((b: { type: string }) => b.type === "document");
    expect(doc.source).toMatchObject({ type: "base64", media_type: "application/pdf", data: "JVBERi0x" });
    expect(args.output_config.format.type).toBe("json_schema");
  });

  it("takes rendered pages instead, for a model that can see but cannot take a PDF", async () => {
    const pageImages = [{ base64: "AAA", mediaType: "image/jpeg" }, { base64: "BBB", mediaType: "image/jpeg" }];
    const res = await call({ auth: "valid", body: JSON.stringify({ sourceFile: "coronary.pdf", pageImages, patient: PATIENT }) });
    expect(res.status).toBe(200);

    const content = create.mock.calls[0][0].messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === "image").map((b: { source: { data: string } }) => b.source.data)).toEqual(["AAA", "BBB"]);
    expect(content.some((b: { type: string }) => b.type === "document")).toBe(false);
  });
});

describe("/api/extract error mapping", () => {
  it("422s when the model returns an invalid extraction (schema validation fails)", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ...VALID_REPORT, studyType: "" }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(422);
    expect((await res.json()).errorCode).toBe("invalid_extraction");
  });

  // An extraction the model got wrong is classified, so the middleware never sees it and the user
  // only ever sees "could not extract this report" — it reaches us only if the route files it.
  it("files an invalid extraction, reporting the code rather than the document it quotes", async () => {
    const github = { ...ENV, CLIENT_ERROR_GITHUB_TOKEN: "ghp_test", CLIENT_ERROR_GITHUB_REPO: "promontory-studio/plover-factory" };
    const issues: { title: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/issues?")) return Response.json([]);
      issues.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 201 });
    });
    create.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ...VALID_REPORT, studyType: "" }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const res = await call({ auth: "valid", env: github as typeof ENV });
    expect(res.status).toBe(422);
    await Promise.all(background);
    vi.unstubAllGlobals();

    expect(issues).toHaveLength(1);
    expect(issues[0].title).toContain("Server error: /api/extract");
    expect(issues[0].body).toContain("invalid_extraction");
    expect(issues[0].body).not.toContain("coronary.pdf");
  });

  it("does not file a document the model correctly refused as not a report", async () => {
    create.mockRejectedValue(new Error('report "holiday-photo.pdf" is not a medical report: it is a photograph'));
    expect((await call({ auth: "valid" })).status).toBe(422);
    expect(background).toEqual([]);
  });

  it("maps an insufficient-credit Anthropic error to 402", async () => {
    create.mockRejectedValue(Object.assign(new Error("credit balance is too low"), { status: 400 }));
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(402);
    expect((await res.json()).errorCode).toBe("insufficient_credit");
  });
});

describe("/api/extract logging is PHI-free", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("logs route/status only — never the report bytes or patient", async () => {
    const lines: string[] = [];
    spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { lines.push(String(l)); });
    await call({ auth: "valid" });
    const entry = JSON.parse(lines.find((l) => l.includes('"/api/extract"'))!);
    expect(entry).toMatchObject({ route: "/api/extract", status: 200 });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("JVBERi0x");
    expect(serialized).not.toContain("1980-01-01");
  });
});
