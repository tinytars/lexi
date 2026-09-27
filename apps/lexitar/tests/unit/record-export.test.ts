// The export's two decisions, both pure and both worth pinning: what gets fetched, and what stdout is
// allowed to say about it.
//
// The second is the one that would fail silently. The common caller is an agent, so a summary that
// leaked a name or a filename would turn every run into a second copy of the record inside a
// transcript nobody treats as PHI. The assertion below is the machine-checked form of that rule.
import { describe, it, expect } from "vitest";
import {
  collectAttachments,
  outputNames,
  planDocuments,
  summaryLines,
  type DocEntry,
  type Manifest,
} from "../../scripts/record-export";
import type { Client } from "../../src/lib/types";

const DISPLAY_NAME = "Alpha Patient";
const base: Client = {
  displayName: DISPLAY_NAME,
  dob: "1980-02-03",
  gender: "male",
  watchlist: [],
  results: [],
};

const client = (over: Partial<Client> & Record<string, unknown> = {}): Client => ({ ...base, ...over }) as Client;

describe("collectAttachments", () => {
  it("finds an attachment however deep the record buries it", () => {
    const deep = client({
      results: [],
      treatments: [
        {
          doses: [
            {
              attachments: [
                {
                  key: "aaaaaaaa-scan.png",
                  name: "scan.png",
                  mediaType: "image/png",
                  bytes: 9,
                  addedAt: "x",
                },
              ],
            },
          ],
        },
      ],
    } as Record<string, unknown>);
    expect(collectAttachments(deep).get("aaaaaaaa-scan.png")).toBe("scan.png");
  });

  it("ignores an object that merely has a key", () => {
    expect(
      collectAttachments(
        client({
          personalizedRanges: { ldl: { key: "not-an-attachment" } },
        } as Record<string, unknown>),
      ).size,
    ).toBe(0);
  });
});

describe("planDocuments", () => {
  const withSources = client({
    sources: [
      {
        id: "abc123456789",
        sha256: "abc12345" + "0".repeat(56),
        kind: "lab",
        file: "records/x.pdf",
        originalName: "labs 2026.pdf",
        importedAt: "2026-01-01",
      },
    ],
    pendingUploads: [
      {
        id: "def456789012",
        sha256: "def45678" + "0".repeat(56),
        file: "def45678-dexa.xlsx",
        originalName: "dexa.xlsx",
        uploadedAt: "2026-01-02",
      },
    ],
  });

  it("names a document from the source record that shares its content hash", () => {
    const [doc] = planDocuments(withSources, ["abc12345-labs_2026.pdf"]);
    expect(doc).toMatchObject({
      originalName: "labs 2026.pdf",
      kind: "lab",
      referenced: true,
      sha8: "abc12345",
    });
  });

  it("names a pending upload the CLI has not processed yet", () => {
    expect(planDocuments(withSources, ["def45678-dexa.xlsx"])[0]).toMatchObject({
      originalName: "dexa.xlsx",
      kind: "pending",
      referenced: true,
    });
  });

  it("exports an object the record no longer mentions, marked unreferenced rather than dropped", () => {
    expect(planDocuments(withSources, ["99999999-orphan.pdf"])[0]).toMatchObject({
      kind: "unknown",
      referenced: false,
      originalName: "orphan.pdf",
    });
  });

  it("orders by key so two runs of the same record produce the same manifest", () => {
    expect(planDocuments(withSources, ["b-two.pdf", "a-one.pdf"]).map((d) => d.file)).toEqual(["a-one.pdf", "b-two.pdf"]);
  });
});

describe("outputNames", () => {
  const entry = (file: string, originalName: string, sha8: string | null): DocEntry => ({
    file,
    sha8,
    originalName,
    kind: "lab",
    referenced: true,
  });

  it("keeps the original name when it is unique", () => {
    expect(outputNames([entry("aaaaaaaa-x.pdf", "labs.pdf", "aaaaaaaa")]).get("aaaaaaaa-x.pdf")).toBe("labs.pdf");
  });

  it("disambiguates two documents that share a name, rather than overwriting one with the other", () => {
    const names = outputNames([entry("a-x.pdf", "labs.pdf", "aaaaaaaa"), entry("b-x.pdf", "labs.pdf", "bbbbbbbb")]);
    expect([...names.values()]).toEqual(["aaaaaaaa-labs.pdf", "bbbbbbbb-labs.pdf"]);
  });

  it("sanitizes a name that would escape the export directory or hide the file", () => {
    const name = outputNames([entry("a", "../../etc/passwd", "aaaaaaaa")]).get("a")!;
    expect(name).not.toContain("/");
    expect(name.startsWith(".")).toBe(false);
  });
});

describe("summaryLines", () => {
  const manifest = (over: Partial<Manifest> = {}): Manifest => ({
    exportedAt: "2026-09-27T00:00:00.000Z",
    baseUrl: "http://localhost:8788",
    accountId: "acct-1",
    vaultId: "vault-1",
    blobId: "blob-1",
    clientKey: "blob-1",
    rotationPending: false,
    documents: [
      {
        file: "abc12345-labs.pdf",
        sha8: "abc12345",
        originalName: "Alpha Patient labs.pdf",
        kind: "lab",
        referenced: true,
        savedAs: "documents/Alpha_Patient_labs.pdf",
        bytes: 4096,
        sealed: true,
        transcriptChars: 812,
      },
      {
        file: "def45678-old.pdf",
        sha8: "def45678",
        originalName: "old.pdf",
        kind: "unknown",
        referenced: false,
        savedAs: "documents/old.pdf",
        bytes: 128,
        sealed: true,
        unreadable: "missing content key",
      },
    ],
    ...over,
  });

  it("says nothing a transcript should not hold — no name, no date of birth, no file name", () => {
    const text = summaryLines(manifest()).join("\n");
    expect(text).not.toContain(DISPLAY_NAME);
    expect(text).not.toContain("1980-02-03");
    expect(text).not.toContain("labs.pdf");
  });

  it("counts what it exported and what it could not open", () => {
    expect(summaryLines(manifest())).toContain("2 documents · 4224 bytes · 1 unreadable");
  });

  it("names the reason a document could not be opened instead of skipping it", () => {
    expect(summaryLines(manifest()).join("\n")).toContain("unreadable(missing content key)");
  });

  it("reports an unreferenced object as such", () => {
    expect(summaryLines(manifest()).join("\n")).toContain("unreferenced");
  });

  it("surfaces a pending re-key rather than reading past it", () => {
    expect(summaryLines(manifest({ rotationPending: true })).join("\n")).toContain("rotation_pending");
  });
});
