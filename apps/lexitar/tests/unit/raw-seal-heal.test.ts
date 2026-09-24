// The browser sealing lane, with a real seal and a real key ring — only the network is stubbed.
// What is under test is the diff and the ordering around putRaw, neither of which a stub decides.
import { afterEach, describe, expect, it, vi } from "vitest";
import { healRawSealing } from "../../src/lib/raw-seal-heal";
import { clearRawKeyring, rawKeyFor, setRawKeyring, setRawKeySink, withRawKey } from "../../src/lib/vault-raw-keys";
import { isSealed, openRaw, sealRaw } from "../../src/lib/raw-cipher";
import type { Vault } from "../../src/lib/types";

const KEY = "A".repeat(43) + "=";
const plain = (file: string): Uint8Array => new TextEncoder().encode(`the bytes of ${file}`);

interface Put {
  file: string;
  body: Uint8Array;
}

/** Stands in for /api/raw: answers `?files=1` with the namespace, serves each file, records PUTs. */
function server(files: string[], stored: Record<string, Uint8Array> = {}): Put[] {
  const puts: Put[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("?files=1")) return Response.json({ files });
      const file = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      if (init?.method === "PUT") {
        puts.push({ file, body: new Uint8Array(init.body as ArrayBuffer) });
        return new Response(null, { status: 204 });
      }
      return new Response((stored[file] ?? plain(file)) as BodyInit);
    }),
  );
  return puts;
}

/** An open vault that records every key the lane mints, the way App.svelte's sink does. */
function openVault(): void {
  let vault = { clients: {} } as Vault;
  setRawKeySink(async (id, file, key) => void (vault = withRawKey(vault, id, file, key)));
}

afterEach(clearRawKeyring);

describe("healRawSealing", () => {
  it("seals every plaintext original the namespace still holds", async () => {
    openVault();
    const puts = server(["one.pdf", "two.pdf"]);

    expect(await healRawSealing("Alex")).toEqual({ sealed: 2, unopenable: 0 });
    expect(puts.map((p) => p.file)).toEqual(["one.pdf", "two.pdf"]);
    expect(await openRaw(puts[0].body, "one.pdf", rawKeyFor("alex", "one.pdf"))).toEqual(plain("one.pdf"));
  });

  // The diff is against the key ring, so a file already sealed costs no download at all.
  it("leaves a file the ring already holds a key for alone", async () => {
    setRawKeyring({ rawKeys: { alex: { "one.pdf": KEY } } });
    const puts = server(["one.pdf"]);

    expect(await healRawSealing("alex")).toEqual({ sealed: 0, unopenable: 0 });
    expect(puts).toEqual([]);
  });

  // Sealed with no key on the ring: re-sealing would need plaintext this lane cannot produce, so it
  // is counted rather than retried on every record open.
  it("counts a sealed object whose key this vault has lost, without re-uploading it", async () => {
    openVault();
    const puts = server(["gone.pdf"], { "gone.pdf": await sealRaw(plain("gone.pdf"), KEY) });

    expect(await healRawSealing("alex")).toEqual({ sealed: 0, unopenable: 1 });
    expect(puts).toEqual([]);
  });

  // Best effort, behind the open record: a file that fails stays plaintext and readable, and the
  // next record open retries it.
  it("keeps going past a file it cannot fetch", async () => {
    openVault();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("?files=1")) return Response.json({ files: ["gone.pdf", "two.pdf"] });
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        return url.includes("gone.pdf") ? new Response(null, { status: 404 }) : new Response(plain("two.pdf") as BodyInit);
      }),
    );

    expect(await healRawSealing("alex")).toEqual({ sealed: 1, unopenable: 0 });
  });

  // No vault means no place to record a key, and putRaw then uploads plaintext. Counting that as
  // sealed would hide the file from the next open, which is the one chance it has.
  it("does not count an upload that stayed plaintext because no vault was open", async () => {
    const puts = server(["one.pdf"]);

    await healRawSealing("alex");

    expect(isSealed(puts[0].body)).toBe(false);
  });

  it("does nothing when the namespace is not readable, rather than throwing behind the UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(healRawSealing("alex")).resolves.toEqual({ sealed: 0, unopenable: 0 });
  });
});
