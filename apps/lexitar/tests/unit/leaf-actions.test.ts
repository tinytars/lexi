import { describe, it, expect, vi } from "vitest";
import { standardLeafActions, buildNoteAttachment } from "../../src/lib/leaf-actions";
import { registerAttachPicker } from "@tinytars/frame/attach-controller";

const attachTarget = { clientId: "alex", onAttached: vi.fn() };

describe("standardLeafActions", () => {
  it("orders items Edit → Chat → Annotate → Attach → Preview → Download → extra → Delete", () => {
    const items = standardLeafActions({
      edit: vi.fn(),
      chat: vi.fn(),
      annotate: vi.fn(),
      // attach takes an AttachTarget, not a callback — vi.fn() only "worked" because the builder
      // checks truthiness to decide whether to include the item.
      attach: { clientId: "c1", onAttached: vi.fn() },
      preview: vi.fn(),
      download: vi.fn(),
      extra: [{ key: "custom", label: "Custom", onClick: vi.fn() }],
      delete: vi.fn(),
    });
    expect(items.map((i) => i.key ?? i.label)).toEqual([
      "edit", "chat", "annotate", "attach", "preview", "download", "custom", "delete",
    ]);
  });

  it("omits any slot whose callback is undefined", () => {
    const items = standardLeafActions({ chat: vi.fn(), delete: vi.fn() });
    expect(items.map((i) => i.key)).toEqual(["chat", "delete"]);
  });

  it("Delete is always danger, everything else isn't", () => {
    const items = standardLeafActions({ edit: vi.fn(), chat: vi.fn(), delete: vi.fn() });
    const del = items.find((i) => i.key === "delete")!;
    expect(del.danger).toBe(true);
    expect(items.filter((i) => i.key !== "delete").every((i) => !i.danger)).toBe(true);
  });

  it("capabilities:false omits an item even when its callback is provided", () => {
    const items = standardLeafActions({
      edit: vi.fn(),
      chat: vi.fn(),
      annotate: vi.fn(),
      capabilities: { annotate: false },
    });
    expect(items.map((i) => i.key)).toEqual(["edit", "chat"]);
  });

  it("capabilities defaults every action on when unset", () => {
    const items = standardLeafActions({ edit: vi.fn(), chat: vi.fn() });
    expect(items).toHaveLength(2);
  });

  it("running the delete item calls through to the callback", () => {
    const onDelete = vi.fn();
    const items = standardLeafActions({ delete: onDelete });
    items[0].onClick();
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe("standardLeafActions — attach (no window, i.e. a fine/desktop pointer)", () => {
  it("renders a single 'Attach' item in the canonical position", () => {
    const items = standardLeafActions({ edit: vi.fn(), chat: vi.fn(), attach: attachTarget });
    expect(items.map((i) => i.key)).toEqual(["edit", "chat", "attach"]);
  });

  it("is omitted when capabilities.attach is false", () => {
    const items = standardLeafActions({ edit: vi.fn(), attach: attachTarget, capabilities: { attach: false } });
    expect(items.map((i) => i.key)).toEqual(["edit"]);
  });
});

describe("standardLeafActions — attach on a coarse pointer", () => {
  it("expands into Take photo / Photo library / Choose file", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const items = standardLeafActions({ chat: vi.fn(), attach: attachTarget });
    expect(items.map((i) => i.key)).toEqual(["chat", "attach-camera", "attach-library", "attach-files"]);
  });
});

// W50 — Chat merges "Add file" into Attach by routing a picked PDF/XLSX through report-ingest
// instead of the generic attachFiles() upload every other Attach use makes.
describe("standardLeafActions — attach routeFile", () => {
  it("a claimed file skips attachFiles/onAttached; an unclaimed one still uploads normally", async () => {
    const puts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") puts.push(url);
      return new Response(null, { status: 204 });
    }));
    let capturedOnFiles: ((files: File[]) => void) | undefined;
    registerAttachPicker((_mode, onFiles) => { capturedOnFiles = onFiles; });

    const onAttached = vi.fn();
    const routeFile = vi.fn(async (f: File) => f.name.endsWith(".pdf"));
    const items = standardLeafActions({ attach: { clientId: "alex", onAttached, routeFile } });
    items[0].onClick();

    const pdfFile = new File([new Uint8Array([1])], "report.pdf", { type: "application/pdf" });
    const imgFile = new File([new Uint8Array([2])], "photo.jpg", { type: "image/jpeg" });
    await capturedOnFiles!([pdfFile, imgFile]);

    expect(routeFile).toHaveBeenCalledTimes(2);
    expect(puts).toHaveLength(1); // only the image went through the generic upload
    expect(onAttached).toHaveBeenCalledOnce();
    expect(onAttached.mock.calls[0][0]).toHaveLength(1);
    expect(onAttached.mock.calls[0][0][0].name).toBe("photo.jpg");
  });

  it("onAttached is never called when every file is claimed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    let capturedOnFiles: ((files: File[]) => void) | undefined;
    registerAttachPicker((_mode, onFiles) => { capturedOnFiles = onFiles; });

    const onAttached = vi.fn();
    const items = standardLeafActions({
      attach: { clientId: "alex", onAttached, routeFile: async () => true },
    });
    items[0].onClick();
    await capturedOnFiles!([new File([new Uint8Array([1])], "report.pdf", { type: "application/pdf" })]);

    expect(onAttached).not.toHaveBeenCalled();
  });
});

describe("buildNoteAttachment", () => {
  it("assembles kind/permalink/preview verbatim", () => {
    const permalink = { tab: "labs" as const, section: "healthReports", anchor: "report-1" };
    const preview = { title: "Echo", subtitle: "2024-01-01", tag: "Reports" };
    expect(buildNoteAttachment("report", permalink, preview)).toEqual({ kind: "report", permalink, preview });
  });
});
