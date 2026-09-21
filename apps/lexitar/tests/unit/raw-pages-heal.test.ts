// pdf.js cannot run under vitest (its worker entry resolves to nothing outside a bundler), so
// openPdf is mocked here as every other suite that touches it does. What is real is the loop around
// it: which files get fetched, which counts reach the server, and what happens to a file that will
// not open — none of which the mock decides.
import { describe, expect, it, vi } from "vitest";

const PAGES: Record<string, number> = { "one.pdf": 1, "nine.pdf": 9 };
vi.mock("@tinytars/frame/pdf-render", () => ({
  openPdf: vi.fn(async (bytes: Uint8Array) => {
    const pages = PAGES[new TextDecoder().decode(bytes)];
    if (pages === undefined) throw new Error("not a pdf");
    return { numPages: pages };
  }),
}));

const { healRawPageCounts } = await import("../../src/lib/raw-pages-heal");

interface Posted {
  clientId: string;
  counts: { file: string; pages: number }[];
}

/** Stands in for /api/raw: lists `unmeasured`, serves each file's name as its bytes, records POSTs. */
function server(unmeasured: string[], readable = unmeasured) {
  const posted: Posted[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/raw/measure") {
        const body = JSON.parse(init!.body as string) as Posted;
        posted.push(body);
        return Response.json({ measured: body.counts.length, remaining: 0 });
      }
      if (url.endsWith("?unmeasured=1")) return Response.json({ files: unmeasured });
      const file = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      return readable.includes(file) ? new Response(file) : new Response(null, { status: 404 });
    }),
  );
  return posted;
}

describe("healRawPageCounts", () => {
  it("counts each unmeasured PDF and posts the counts back under the normalized client id", async () => {
    const posted = server(["one.pdf", "nine.pdf"]);

    expect(await healRawPageCounts("Alex")).toBe(2);
    expect(posted).toEqual([
      { clientId: "alex", counts: [{ file: "one.pdf", pages: 1 }, { file: "nine.pdf", pages: 9 }] },
    ]);
  });

  it("posts nothing when the server has nothing unmeasured", async () => {
    const posted = server([]);

    expect(await healRawPageCounts("alex")).toBe(0);
    expect(posted).toEqual([]);
  });

  it("leaves a PDF it cannot open unmeasured and still posts the ones it can", async () => {
    const posted = server(["broken.pdf", "nine.pdf"]);

    expect(await healRawPageCounts("alex")).toBe(1);
    expect(posted[0].counts).toEqual([{ file: "nine.pdf", pages: 9 }]);
  });

  it("skips a listed file whose bytes cannot be fetched", async () => {
    const posted = server(["one.pdf", "gone.pdf"], ["one.pdf"]);

    expect(await healRawPageCounts("alex")).toBe(1);
    expect(posted[0].counts).toEqual([{ file: "one.pdf", pages: 1 }]);
  });

  it("does nothing when the namespace is not readable, rather than throwing behind the UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(healRawPageCounts("alex")).resolves.toBe(0);
  });
});
