// @vitest-environment jsdom
// What the host's file listing SAYS must never stand in place of what the store DID.
//
// The listing behind `missing-attachments.svelte.ts` answers from recorded object rows, which began
// part-way through this app's life, so a key it omits may have perfectly readable bytes. A chip that
// renders a symbol in its content's place never fetches at all, which makes the claim unfalsifiable
// by the one thing that could measure it — and the viewer, which does still fetch, used to print
// "nothing can open it" directly above its own live Download link.
//
// So: the claim annotates (badge, title), and the absence sentence waits for a fetch that failed.
// The last two cases pass already and are here so the over-correction — deleting the claim outright
// — cannot pass as a fix.
import { afterEach, expect, it } from "vitest";
import { flushSync } from "svelte";
import { render } from "../support/mount";
import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
import AttachmentViewer from "@tinytars/frame/AttachmentViewer.svelte";
import { setMissingAttachments, clearMissingAttachments } from "@tinytars/frame/missing-attachments.svelte";
import type { AttachmentUrl } from "@tinytars/frame/attachment-url.svelte";

const GONE = "1700000000-front.jpg";
const photo = { key: GONE, name: "front.jpg", mediaType: "image/jpeg", bytes: 4096, addedAt: "2026-07-21T00:00:00.000Z" };

// Which keys were actually asked for, so "a fetch was attempted" is an assertion rather than an
// inference from whatever rendered.
const asked: string[] = [];
const serves: AttachmentUrl = async (_clientId, key) => (asked.push(key), "blob:bytes-are-there");
const refuses: AttachmentUrl = async (_clientId, key) => {
  asked.push(key);
  throw new Error("fetching the attachment failed (404)");
};

/** The stub resolves a microtask later; one macrotask turn is strictly past that. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r));
  flushSync();
}

afterEach(() => {
  clearMissingAttachments();
  asked.length = 0;
});

const strip = (attachmentUrl: AttachmentUrl) =>
  render(AttachmentStrip, { attachments: [photo], clientId: "alex", attachmentUrl, productName: "the assistant" });

const viewer = (attachmentUrl: AttachmentUrl) =>
  render(AttachmentViewer, { attachments: [photo], index: 0, clientId: "alex", attachmentUrl, onClose: () => {} });

it("fetches a key the listing omits, and shows the image the store actually holds", async () => {
  setMissingAttachments([GONE]);
  const el = strip(serves);
  await settle();

  expect(asked).toEqual([GONE]);
  expect(el.querySelector(".attachment-link img")?.getAttribute("src")).toBe("blob:bytes-are-there");
  // The claim keeps the two jobs it is allowed: the badge, and the title behind it.
  expect(el.querySelector(".attachment-badge.failed")).not.toBeNull();
});

it("names no absence in the viewer when the bytes arrive, where the Download link is live", async () => {
  setMissingAttachments([GONE]);
  const el = viewer(serves);
  await settle();

  expect(el.textContent).not.toContain("missing from storage");
  // getAttribute, not .href: jsdom resolves the property against the document base.
  expect(el.querySelector("a.viewer-download")?.getAttribute("href")).toBe("blob:bytes-are-there");
  expect(el.querySelector("img.viewer-image")).not.toBeNull();
});

it("names the absence once the fetch has failed and the listing agrees", async () => {
  setMissingAttachments([GONE]);
  const el = viewer(refuses);
  await settle();

  expect(el.textContent).toContain("missing from storage");
  expect(el.querySelector("a.viewer-download")).toBeNull();
  expect(el.querySelector(".viewer-download.is-disabled")).not.toBeNull();
});

it("shows the fetch's own reason for a failure the listing never predicted", async () => {
  const el = viewer(refuses);
  await settle();

  expect(el.textContent).toContain("fetching the attachment failed (404)");
  expect(el.textContent).not.toContain("missing from storage");
});
