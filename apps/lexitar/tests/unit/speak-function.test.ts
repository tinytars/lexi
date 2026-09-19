import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onRequestPost } from "../../functions/api/speak";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";

// Only the vendor edge is faked: the relay's own validation, SSML building, and error mapping run for real.
const ENV = { SESSION_SECRET: "test-secret", DB: fakeSessionDb(), AZURE_SPEECH_KEY: "speech-key", AZURE_SPEECH_REGION: "eastus" };
let vendor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vendor = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
  vi.stubGlobal("fetch", vendor);
});
afterEach(() => vi.unstubAllGlobals());

async function call(body: unknown, { auth = true, env = ENV }: { auth?: boolean; env?: Partial<typeof ENV> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  return onRequestPost({ request: new Request("http://x/api/speak", { method: "POST", headers, body: JSON.stringify(body) }), env: env as typeof ENV });
}

describe("/api/speak", () => {
  it("synthesizes the text in the persona's neural voice and returns mp3", async () => {
    const res = await call({ voice: "kodi", text: "LDL is 113 & falling <slowly>." });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = vendor.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("speech-key");
    expect(init.body).toContain("<voice name=\"en-US-AndrewMultilingualNeural\">");
    expect(init.body).toContain("LDL is 113 &amp; falling &lt;slowly&gt;.");
  });

  it("uses Lexi's voice when no voice is given", async () => {
    await call({ text: "Hello." });
    expect((vendor.mock.calls[0][1] as RequestInit).body).toContain("en-US-AvaMultilingualNeural");
  });

  it("rejects a voice outside the persona registry instead of passing it to the vendor", async () => {
    const res = await call({ voice: "en-US-SomeoneElse", text: "Hello." });
    expect(res.status).toBe(400);
    expect(vendor).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    expect((await call({ text: "Hello." }, { auth: false })).status).toBe(401);
    expect(vendor).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized text", async () => {
    expect((await call({ text: "  " })).status).toBe(400);
    expect((await call({ text: "x".repeat(3000) })).status).toBe(413);
    expect(vendor).not.toHaveBeenCalled();
  });

  it("answers 503 when speech is not configured, so the browser falls back to its own voice", async () => {
    const res = await call({ text: "Hello." }, { env: { ...ENV, AZURE_SPEECH_KEY: undefined } });
    expect(res.status).toBe(503);
    expect(vendor).not.toHaveBeenCalled();
  });

  it("maps a vendor failure to 502", async () => {
    vendor.mockResolvedValueOnce(new Response("quota", { status: 429 }));
    expect((await call({ text: "Hello." })).status).toBe(502);
  });
});
